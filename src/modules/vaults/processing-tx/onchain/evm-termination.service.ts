import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmVaultOnchainStatus, VAULT_ABI } from './vault.abi';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

export interface BeginTerminationResult {
  txHash: Hex;
  vtSupply: bigint;
  nativeSnapshot: bigint;
}

@Injectable()
export class EvmTerminationService {
  private readonly logger = new Logger(EvmTerminationService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  /**
   * Phase 4 step 1: require Locked/Cancelled, no open positions, no NFTs held.
   * Transitions on-chain vault → TerminationPreparing.
   */
  async beginTerminationPreparing(vaultId: string): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;

    if (
      onchainStatus !== EvmVaultOnchainStatus.Locked &&
      onchainStatus !== EvmVaultOnchainStatus.Cancelled
    ) {
      throw new BadRequestException(
        `Vault ${vaultAddress} is ${EvmVaultOnchainStatus[onchainStatus]}; must be Locked or Cancelled`
      );
    }

    const activePositions = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'activeExternalPositionCount',
    })) as bigint;

    if (activePositions > 0n) {
      throw new BadRequestException(
        `Vault ${vaultAddress} has ${activePositions} active position(s). Close them before terminating.`
      );
    }

    return this._sendSimple(
      vaultId,
      vault,
      vaultAddress,
      TransactionType.evmBeginTerminationPreparing,
      'beginTerminationPreparing',
      [],
      'TerminationPrepared',
      null // no DB status transition yet
    );
  }

  /**
   * Phase 4 step 2: snapshot VT supply + custody, list distributable assets.
   * Transitions on-chain → Terminating. DB vault → terminating.
   */
  async beginTermination(vaultId: string, distributableAssets: Address[]): Promise<BeginTerminationResult> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;

    if (onchainStatus !== EvmVaultOnchainStatus.TerminationPreparing) {
      throw new BadRequestException(
        `Vault ${vaultAddress} is ${EvmVaultOnchainStatus[onchainStatus]}; must be TerminationPreparing`
      );
    }

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmBeginTermination,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'TerminationSnapshotTaken', count: 1 }],
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'beginTermination', args: [distributableAssets] },
        ['TerminationSnapshotTaken'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, 'beginTermination');
      throw err;
    }

    const evt = result.decodedEvents.find(
      e => e.eventName === 'TerminationSnapshotTaken' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const args = evt?.args as { vtSupply?: bigint; nativeSnapshot?: bigint } | undefined;

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
      await manager.update(Vault, { id: vaultId }, { vault_status: VaultStatus.terminating });
    });

    this.logger.log(`beginTermination confirmed vault=${vaultId} vtSupply=${args?.vtSupply} tx=${result.hash}`);
    return {
      txHash: result.hash,
      vtSupply: args?.vtSupply ?? 0n,
      nativeSnapshot: args?.nativeSnapshot ?? 0n,
    };
  }

  /**
   * Phase 4 step 3 (final): call after all VT is burned (outstandingVt == 0).
   * Transitions on-chain → Terminated. DB vault → terminated.
   */
  async finalizeTermination(vaultId: string): Promise<{ txHash: Hex }> {
    const result = await this._sendSimple(
      vaultId,
      await this._requireEvmVault(vaultId),
      (await this._requireEvmVault(vaultId)).contract_address as Address,
      TransactionType.evmFinalizeTermination,
      'finalizeTermination',
      [],
      'VaultStatusChanged',
      VaultStatus.burned
    );

    return result;
  }

  // ---------------------------------------------------------------------------

  private async _sendSimple(
    vaultId: string,
    vault: Vault,
    vaultAddress: Address,
    txType: TransactionType,
    fnName: string,
    args: unknown[],
    expectedEvent: string,
    nextVaultStatus: VaultStatus | null
  ): Promise<{ txHash: Hex }> {
    const adminTx = this.transactionsRepository.create({
      type: txType,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: expectedEvent, count: 1 }],
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: fnName as any, args: args as any },
        [expectedEvent],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, fnName);
      throw err;
    }

    if (nextVaultStatus) {
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
        await manager.update(Vault, { id: vaultId }, { vault_status: nextVaultStatus });
      });
    } else {
      await this.transactionsRepository.update(
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
    }

    this.logger.log(`${fnName} confirmed vault=${vaultId} tx=${result.hash}`);
    return { txHash: result.hash };
  }

  private async _requireEvmVault(vaultId: string): Promise<Vault> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }
    return vault;
  }

  private async _handleBroadcastError(adminTxId: string, err: unknown, fn: string): Promise<void> {
    if (err instanceof TxRevertedError) {
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.failed,
          tx_hash: err.hash,
          reconciliation_status: EvmReconciliationStatus.failed,
          reconciliation_last_error: `${fn} reverted: ${err.message.slice(0, 500)}`,
        }
      );
    } else {
      await this.transactionsRepository.update(
        { id: adminTxId },
        { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message?.slice(0, 500)}` }
      );
    }
  }
}
