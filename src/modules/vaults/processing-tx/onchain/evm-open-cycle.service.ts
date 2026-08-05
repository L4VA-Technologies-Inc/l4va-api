import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmCycleStatus, EvmVaultOnchainStatus, VAULT_ABI } from './vault.abi';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

export interface EvmCycleWindowConfig {
  start: bigint;
  end: bigint;
}

export interface EvmOpenCycleConfig {
  assetWindow: EvmCycleWindowConfig;
  acquireWindow: EvmCycleWindowConfig;
  minAcquireThreshold: bigint;
  /** LP-pair mint rate (1e18-scaled). Pass 0n if LP is not used. */
  adaPairVtPerNativeUnit: bigint;
  assetWhitelist: Address[];
  contributorWhitelist: Address[];
}

export interface OpenCycleResult {
  txHash: Hex;
  cycleId: bigint;
}

@Injectable()
export class EvmOpenCycleService {
  private readonly logger = new Logger(EvmOpenCycleService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  /**
   * Open a new contribution cycle on-chain. Callable after `closeCycle` (Locked)
   * or after `cancelCurrentCycle` (Cancelled). Creates a Transaction row for
   * reconciliation and updates the vault's DB status to `acquire`.
   */
  async openCycleForVault(vaultId: string, cfg: EvmOpenCycleConfig): Promise<OpenCycleResult> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }

    const vaultAddress = vault.contract_address as Address;

    // Preflight: on-chain status must be Locked or Cancelled.
    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;

    if (onchainStatus !== EvmVaultOnchainStatus.Locked && onchainStatus !== EvmVaultOnchainStatus.Cancelled) {
      throw new BadRequestException(
        `Vault ${vaultAddress} on-chain status is ${EvmVaultOnchainStatus[onchainStatus]}; ` +
          `must be Locked or Cancelled to open a new cycle`
      );
    }

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmOpenCycle,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'CycleOpened', count: 1 }],
    });
    await this.transactionsRepository.save(adminTx);

    const cycleArg = {
      assetWindow: { start: cfg.assetWindow.start, end: cfg.assetWindow.end },
      acquireWindow: { start: cfg.acquireWindow.start, end: cfg.acquireWindow.end },
      minAcquireThreshold: cfg.minAcquireThreshold,
      adaPairVtPerNativeUnit: cfg.adaPairVtPerNativeUnit,
      assetWhitelist: cfg.assetWhitelist,
      contributorWhitelist: cfg.contributorWhitelist,
    };

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'openCycle', args: [cycleArg] },
        ['CycleOpened'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      if (err instanceof TxRevertedError) {
        await this.transactionsRepository.update(
          { id: adminTx.id },
          {
            status: TransactionStatus.failed,
            tx_hash: err.hash,
            reconciliation_status: EvmReconciliationStatus.failed,
            reconciliation_last_error: `openCycle reverted: ${err.message.slice(0, 500)}`,
          }
        );
        throw err;
      }
      await this.transactionsRepository.update(
        { id: adminTx.id },
        { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message.slice(0, 500)}` }
      );
      throw err;
    }

    // Decode returned cycleId from CycleOpened event.
    const evt = result.decodedEvents.find(
      e => e.eventName === 'CycleOpened' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const cycleId = evt ? BigInt((evt.args as { cycleId: bigint }).cycleId) : BigInt(0);

    await this.dataSource.transaction(async manager => {
      await manager.update(
        Transaction,
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
      // Transition vault DB status to acquire so contribution endpoints open.
      await manager.update(Vault, { id: vaultId }, { vault_status: VaultStatus.acquire });
    });

    this.logger.log(`openCycle confirmed for vault ${vaultId} — cycleId=${cycleId} tx=${result.hash}`);
    return { txHash: result.hash, cycleId };
  }
}
