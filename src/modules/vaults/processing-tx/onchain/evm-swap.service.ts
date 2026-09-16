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

/** Mirrors `VaultTypes.SwapParams`. `address(0)` = native on either leg. */
export interface SwapParams {
  operationId: Hex;
  adapter: Address;
  assetIn: Address;
  amountIn: bigint;
  assetOut: Address;
  /** Floor on what the vault KEEPS, after the protocol trade fee. */
  minAmountOut: bigint;
  /** Must be non-zero. */
  deadline: bigint;
  /** Adapter-specific typed route. Never carries amounts or a recipient. */
  route: Hex;
}

export interface SwapResult {
  txHash: Hex;
  grossOut: bigint;
  fee: bigint;
}

const PROTOCOL_FEE_CONFIG_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'feeBps',
    inputs: [{ name: 'feeType', type: 'uint8' }],
    outputs: [{ type: 'uint16' }],
  },
] as const;

/** `FeeType.Trade` in IProtocolFeeConfig.sol. */
const FEE_TYPE_TRADE = 2;

/**
 * Admin wrapper around the vault's position-less `swap`.
 *
 * The vault consumes `operationId` before the external call, so a resubmission
 * after a lost receipt reverts instead of trading twice; callers should check
 * {@link isOperationIdUsed} before retrying a leg.
 */
@Injectable()
export class EvmSwapService {
  private readonly logger = new Logger(EvmSwapService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  async swap(vaultId: string, params: SwapParams): Promise<SwapResult> {
    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const adminTx = await this.transactionsRepository.save(
      this.transactionsRepository.create({
        type: TransactionType.evmSwap,
        status: TransactionStatus.pending,
        vault_id: vaultId,
        chain_id: vault.chain_id,
        from_address: this.adminSigner.address,
        to_address: vaultAddress,
        reconciliation_status: EvmReconciliationStatus.pending,
        reconciliation_attempts: 0,
        expected_events: [{ name: 'Swapped', count: 1 }],
        metadata: {
          operationId: params.operationId,
          adapter: params.adapter,
          assetIn: params.assetIn,
          amountIn: params.amountIn.toString(),
          assetOut: params.assetOut,
          minAmountOut: params.minAmountOut.toString(),
        },
      })
    );

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'swap', args: [params] },
        ['Swapped'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this.handleBroadcastError(adminTx.id, err);
      throw err;
    }

    const evt = result.decodedEvents.find(
      e => e.eventName === 'Swapped' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const args = evt?.args as { grossOut: bigint; fee: bigint } | undefined;

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
      `swap confirmed vault=${vaultId} ${params.assetIn}→${params.assetOut} in=${params.amountIn} ` +
        `grossOut=${args?.grossOut} fee=${args?.fee} tx=${result.hash}`
    );
    return { txHash: result.hash, grossOut: args?.grossOut ?? 0n, fee: args?.fee ?? 0n };
  }

  async isOperationIdUsed(vaultAddress: Address, operationId: Hex): Promise<boolean> {
    return this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'isSwapOperationIdUsed',
      args: [operationId],
    }) as Promise<boolean>;
  }

  /** Protocol trade fee the vault takes from swap output, in bps. */
  async tradeFeeBps(vaultAddress: Address): Promise<number> {
    const feeConfig = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'protocolFeeConfig',
    })) as Address;
    const bps = await this.contractReader.publicClient.readContract({
      address: feeConfig,
      abi: PROTOCOL_FEE_CONFIG_ABI,
      functionName: 'feeBps',
      args: [FEE_TYPE_TRADE],
    });
    return Number(bps);
  }

  private async requireEvmVault(vaultId: string): Promise<Vault> {
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

  private async handleBroadcastError(adminTxId: string, err: unknown): Promise<void> {
    if (err instanceof TxRevertedError) {
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.failed,
          tx_hash: err.hash,
          reconciliation_status: EvmReconciliationStatus.failed,
          reconciliation_last_error: `swap reverted: ${err.message.slice(0, 500)}`,
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
