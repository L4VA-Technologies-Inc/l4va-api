import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toHex, type Address, type Hex } from 'viem';

import { ADAPTER_REGISTRY_ABI } from './adapter-registry.abi';
import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';

import { Transaction } from '@/database/transaction.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';

export interface AdapterApproveResult {
  txHash: Hex;
  adapter: Address;
  tag: Hex;
}

/**
 * Admin service for AdapterRegistry.sol.
 * Separate from EvmAdminSigner because it operates on the shared registry
 * contract (one address per factory deployment) rather than individual vaults.
 */
@Injectable()
export class EvmAdapterRegistryService {
  private readonly logger = new Logger(EvmAdapterRegistryService.name);
  private readonly registryAddress: Address;

  constructor(
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    configService: ConfigService
  ) {
    const raw = configService.get<string>('EVM_ADAPTER_REGISTRY_ADDRESS');
    if (!raw) throw new Error('EVM_ADAPTER_REGISTRY_ADDRESS is not configured');
    this.registryAddress = raw as Address;
  }

  async isApproved(adapter: Address): Promise<boolean> {
    return this.contractReader.publicClient.readContract({
      address: this.registryAddress,
      abi: ADAPTER_REGISTRY_ABI,
      functionName: 'approved',
      args: [adapter],
    }) as Promise<boolean>;
  }

  /** Approve an adapter. `tag` is a short label encoded as bytes32. */
  async approveAdapter(adapter: Address, tagLabel: string): Promise<AdapterApproveResult> {
    // Encode label as right-padded bytes32 (max 31 chars to leave room for null terminator)
    const tag = toHex(tagLabel.slice(0, 31), { size: 32 }) as Hex;

    const alreadyApproved = await this.isApproved(adapter);
    if (alreadyApproved) {
      this.logger.warn(`Adapter ${adapter} is already approved — idempotent no-op`);
    }

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmOpenPosition, // reuse closest type; no vault_id for registry ops
      status: TransactionStatus.pending,
      from_address: this.adminSigner.address,
      to_address: this.registryAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'AdapterApproved', count: 1 }],
      metadata: { adapter, tag },
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        {
          address: this.registryAddress,
          abi: ADAPTER_REGISTRY_ABI,
          functionName: 'approveAdapter',
          args: [adapter, tag],
        },
        ['AdapterApproved'],
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
            reconciliation_last_error: `approveAdapter reverted: ${err.message.slice(0, 500)}`,
          }
        );
        throw err;
      }
      await this.transactionsRepository.update(
        { id: adminTx.id },
        { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message?.slice(0, 500)}` }
      );
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

    this.logger.log(`approveAdapter confirmed adapter=${adapter} tag=${tagLabel} tx=${result.hash}`);
    return { txHash: result.hash, adapter, tag };
  }

  async revokeAdapter(adapter: Address): Promise<{ txHash: Hex }> {
    if (!(await this.isApproved(adapter))) {
      throw new BadRequestException(`Adapter ${adapter} is not currently approved`);
    }

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmOpenPosition,
      status: TransactionStatus.pending,
      from_address: this.adminSigner.address,
      to_address: this.registryAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'AdapterRevoked', count: 1 }],
      metadata: { adapter },
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: this.registryAddress, abi: ADAPTER_REGISTRY_ABI, functionName: 'revokeAdapter', args: [adapter] },
        ['AdapterRevoked'],
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
            reconciliation_last_error: `revokeAdapter reverted: ${err.message.slice(0, 500)}`,
          }
        );
        throw err;
      }
      await this.transactionsRepository.update(
        { id: adminTx.id },
        { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message?.slice(0, 500)}` }
      );
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

    this.logger.log(`revokeAdapter confirmed adapter=${adapter} tx=${result.hash}`);
    return { txHash: result.hash };
  }
}
