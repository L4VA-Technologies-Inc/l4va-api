import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { VAULT_ABI } from './vault.abi';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

export interface OpenPositionParams {
  operationId: Hex;
  adapter: Address;
  /** address(0) for empty/unset protocol label */
  protocol: Address;
  /** address(0) for native input */
  inputAsset: Address;
  maxInputAmount: bigint;
  expectedPositionAsset: Address;
  minExpectedOutput: bigint;
  /** 0n = no deadline */
  deadline: bigint;
  /** ABI-encoded adapter-specific params */
  protocolParams: Hex;
}

export interface ClosePositionParams {
  positionId: bigint;
  minUnderlyingReturned: bigint;
  /** 0n = no deadline */
  deadline: bigint;
  protocolParams: Hex;
}

export interface OpenPositionResult {
  txHash: Hex;
  positionId: bigint;
  positionAmount: bigint;
  positionAsset: Address;
  amountConsumed: bigint;
}

export interface ClosePositionResult {
  txHash: Hex;
  positionId: bigint;
  underlyingReturned: bigint;
}

/**
 * Builds a deterministic `operationId` from a vault ID + proposal ID + index.
 * Avoids collisions across retries: same inputs always produce the same id.
 */
export function buildOperationId(vaultId: string, proposalId: string, index: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
      [vaultId, proposalId, BigInt(index)]
    )
  );
}

/**
 * Encode MockAdapter params for testnet: `abi.encode(uint256 inputAmount, uint256 multiplierBps)`.
 * multiplierBps=10000 means 1:1. Used when `ENV == testnet`.
 */
export function encodeMockAdapterParams(inputAmount: bigint, multiplierBps: bigint = 10000n): Hex {
  return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [inputAmount, multiplierBps]) as Hex;
}

@Injectable()
export class EvmPositionService {
  private readonly logger = new Logger(EvmPositionService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  async openPosition(vaultId: string, params: OpenPositionParams): Promise<OpenPositionResult> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmOpenPosition,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'PositionOpened', count: 1 }],
      metadata: { operationId: params.operationId, adapter: params.adapter },
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'openPosition', args: [params] },
        ['PositionOpened'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, 'openPosition');
      throw err;
    }

    const evt = result.decodedEvents.find(
      e => e.eventName === 'PositionOpened' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const args = evt?.args as
      | {
          positionId: bigint;
          positionAmount: bigint;
          positionAsset: Address;
          amountConsumed: bigint;
        }
      | undefined;

    await this.transactionsRepository.update(
      { id: adminTx.id },
      {
        status: TransactionStatus.confirmed,
        reconciliation_status: EvmReconciliationStatus.success,
        reconciled_at: new Date(),
        reconciliation_last_error: null,
      }
    );

    this.logger.log(`openPosition confirmed vault=${vaultId} positionId=${args?.positionId} tx=${result.hash}`);
    return {
      txHash: result.hash,
      positionId: args?.positionId ?? 0n,
      positionAmount: args?.positionAmount ?? 0n,
      positionAsset: args?.positionAsset ?? ('0x' as Address),
      amountConsumed: args?.amountConsumed ?? 0n,
    };
  }

  async closePosition(vaultId: string, params: ClosePositionParams): Promise<ClosePositionResult> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmClosePosition,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'PositionClosed', count: 1 }],
      metadata: { positionId: params.positionId.toString() },
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'closePosition', args: [params] },
        ['PositionClosed'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, 'closePosition');
      throw err;
    }

    const evt = result.decodedEvents.find(
      e => e.eventName === 'PositionClosed' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const underlyingReturned = (evt?.args as { underlyingReturned?: bigint } | undefined)?.underlyingReturned ?? 0n;

    await this.transactionsRepository.update(
      { id: adminTx.id },
      {
        status: TransactionStatus.confirmed,
        reconciliation_status: EvmReconciliationStatus.success,
        reconciled_at: new Date(),
        reconciliation_last_error: null,
      }
    );

    this.logger.log(
      `closePosition confirmed vault=${vaultId} positionId=${params.positionId} returned=${underlyingReturned} tx=${result.hash}`
    );
    return { txHash: result.hash, positionId: params.positionId, underlyingReturned };
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
