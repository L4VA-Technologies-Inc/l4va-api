import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { VAULT_ABI } from './vault.abi';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

@Injectable()
export class EvmPauseService {
  private readonly logger = new Logger(EvmPauseService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  async pause(vaultId: string): Promise<{ txHash: Hex }> {
    return this._send(vaultId, 'pause', TransactionType.evmPause, 'Paused');
  }

  async unpause(vaultId: string): Promise<{ txHash: Hex }> {
    return this._send(vaultId, 'unpause', TransactionType.evmUnpause, 'Unpaused');
  }

  /** Only callable when paused. Sweeps native surplus above custody obligations. */
  async emergencyRecoverNative(vaultId: string): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const paused = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'paused',
    })) as boolean;
    if (!paused) throw new BadRequestException(`Vault ${vaultId} is not paused`);

    return this._send(vaultId, 'emergencyRecoverNative', TransactionType.evmPause, 'EmergencyRecovered');
  }

  async emergencyRecoverERC20(vaultId: string, token: Address): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const paused = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'paused',
    })) as boolean;
    if (!paused) throw new BadRequestException(`Vault ${vaultId} is not paused`);

    return this._sendWithArgs(
      vaultId,
      vault,
      vaultAddress,
      'emergencyRecoverERC20',
      [token],
      TransactionType.evmPause,
      'EmergencyRecovered'
    );
  }

  isPaused(vaultAddress: Address): Promise<boolean> {
    return this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'paused',
    }) as Promise<boolean>;
  }

  private async _send(
    vaultId: string,
    fnName: string,
    txType: TransactionType,
    expectedEvent: string
  ): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    return this._sendWithArgs(vaultId, vault, vault.contract_address as Address, fnName, [], txType, expectedEvent);
  }

  private async _sendWithArgs(
    vaultId: string,
    vault: Vault,
    vaultAddress: Address,
    fnName: string,
    args: unknown[],
    txType: TransactionType,
    expectedEvent: string
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
      if (err instanceof TxRevertedError) {
        await this.transactionsRepository.update(
          { id: adminTx.id },
          {
            status: TransactionStatus.failed,
            tx_hash: err.hash,
            reconciliation_status: EvmReconciliationStatus.failed,
            reconciliation_last_error: `${fnName} reverted: ${err.message.slice(0, 500)}`,
          }
        );
      } else {
        await this.transactionsRepository.update(
          { id: adminTx.id },
          { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message?.slice(0, 500)}` }
        );
      }
      throw err;
    }

    await this.transactionsRepository.update(
      { id: adminTx.id },
      {
        status: TransactionStatus.confirmed,
        reconciliation_status: EvmReconciliationStatus.success,
        reconciled_at: new Date(),
        reconciliation_last_error: null,
      }
    );

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
}
