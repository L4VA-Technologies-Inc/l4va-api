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

/** Decoded `Vault.Swapped` payload. */
interface SwappedArgs {
  operationId: Hex;
  adapter: Address;
  assetIn: Address;
  amountIn: bigint;
  assetOut: Address;
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
    // Set only once writeContract returned a hash: a failure before that point
    // never reached the chain and must not be left for the health sweep.
    const broadcast: { hash?: Hex } = {};
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'swap', args: [params] },
        ['Swapped'],
        async hash => {
          broadcast.hash = hash;
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this.handleBroadcastError(adminTx.id, err, broadcast.hash);
      throw err;
    }

    // A successful receipt is not proof this swap happened: the signer decodes
    // generically and leaves every argument for the caller to check. Without
    // a matching `Swapped` we would record a confirmed trade with zero output
    // and let the rebalance move on as if the leg had filled.
    const args = await this.requireSwappedEvent(adminTx.id, result, vaultAddress, params);

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
        `grossOut=${args.grossOut} fee=${args.fee} tx=${result.hash}`
    );
    return { txHash: result.hash, grossOut: args.grossOut, fee: args.fee };
  }

  /**
   * Find the vault's own `Swapped` log for exactly the payload we broadcast.
   * Every field the vault echoes is compared, so a log from another operation
   * in the same transaction (or from a contract that merely shares the ABI)
   * can never be mistaken for this leg.
   */
  private async requireSwappedEvent(
    adminTxId: string,
    result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>,
    vaultAddress: Address,
    params: SwapParams
  ): Promise<SwappedArgs> {
    const sameAddress = (a: unknown, b: string): boolean => String(a).toLowerCase() === b.toLowerCase();

    const match = result.decodedEvents.find(e => {
      if (e.eventName !== 'Swapped' || !sameAddress(e.address, vaultAddress)) return false;
      const a = e.args as Partial<SwappedArgs>;
      return (
        sameAddress(a.operationId, params.operationId) &&
        sameAddress(a.adapter, params.adapter) &&
        sameAddress(a.assetIn, params.assetIn) &&
        sameAddress(a.assetOut, params.assetOut) &&
        a.amountIn === params.amountIn
      );
    });

    if (!match) {
      const reason =
        `tx ${result.hash} succeeded without a Swapped event matching operationId=${params.operationId} ` +
        `adapter=${params.adapter} ${params.assetIn}→${params.assetOut} in=${params.amountIn}`;
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.manual_review_required,
          reconciliation_last_error: reason.slice(0, 500),
        }
      );
      this.logger.error(`swap event check failed: ${reason}`);
      throw new Error(reason);
    }

    return match.args as unknown as SwappedArgs;
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

  private async handleBroadcastError(adminTxId: string, err: unknown, broadcastHash?: Hex): Promise<void> {
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
      return;
    }

    const message = (err as Error).message?.slice(0, 500);
    if (!broadcastHash) {
      // Simulation / nonce / RPC failure before the transaction existed. The
      // health sweep only follows rows that carry a hash, so leaving this one
      // `pending` would orphan it forever; nothing is on chain to reconcile.
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.failed,
          reconciliation_status: EvmReconciliationStatus.failed,
          reconciliation_last_error: `swap not broadcast: ${message}`,
        }
      );
      return;
    }

    // Broadcast but no receipt yet (timeout). Stays `submitted` with its hash
    // so the health sweep can settle it from chain.
    await this.transactionsRepository.update(
      { id: adminTxId },
      { reconciliation_last_error: `broadcast/receipt: ${message}` }
    );
  }
}
