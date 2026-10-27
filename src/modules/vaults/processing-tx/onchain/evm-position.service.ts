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

/** Asset kinds as ordered in `VaultTypes.AssetKind`. */
export enum EvmAssetKind {
  Native = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
}

/**
 * One governance-approved NFT sale. Every field is fixed by the passed proposal;
 * the admin key only executes it. Marketplace specifics go in `protocolParams`,
 * which the vault never interprets.
 */
export interface SellNftParams {
  /** Deterministic per (vault, proposal, action) — see `buildOperationId`. */
  operationId: Hex;
  adapter: Address;
  nftContract: Address;
  tokenId: bigint;
  /** Must be 1n for ERC-721. */
  quantity: bigint;
  kind: EvmAssetKind.ERC721 | EvmAssetKind.ERC1155;
  /** address(0) for native. Native proceeds must be forwarded by the adapter. */
  paymentAsset: Address;
  /** Floor on what the vault KEEPS, i.e. after the protocol trade fee. */
  minNetProceeds: bigint;
  /** Must be non-zero. */
  deadline: bigint;
  protocolParams: Hex;
}

export interface SellNftResult {
  txHash: Hex;
  grossProceeds: bigint;
  netProceeds: bigint;
  paymentAsset: Address;
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
      metadata: { operationId: params.operationId, adapter: params.adapter, protocol: params.protocol },
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

  /**
   * Sell a vault-held ERC-721/ERC-1155 through an approved marketplace adapter.
   *
   * Termination distributes only native and ERC-20, so NFTs must be resolved
   * before a vault can wind down; this is that exit. The contract verifies the
   * outcome itself — that the NFT actually left, and that the proceeds match a
   * measured balance delta — so a misbehaving adapter reverts the sale.
   *
   * `operationId` is the on-chain replay guard: re-submitting the same proposal
   * reverts rather than selling twice, which makes a retry safe when a
   * transaction lands but the receipt is lost.
   *
   * If the NFT's contribution is still refundable the vault rejects the sale;
   * call {@link releaseNftRefundable} for the backing record(s) first.
   */
  async sellNft(vaultId: string, params: SellNftParams): Promise<SellNftResult> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmSellNft,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'NftSold', count: 1 }],
      metadata: {
        operationId: params.operationId,
        adapter: params.adapter,
        nftContract: params.nftContract,
        tokenId: params.tokenId.toString(),
        quantity: params.quantity.toString(),
        paymentAsset: params.paymentAsset,
        minNetProceeds: params.minNetProceeds.toString(),
      },
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'sellNft', args: [params] },
        ['NftSold'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, 'sellNft');
      throw err;
    }

    const evt = result.decodedEvents.find(
      e => e.eventName === 'NftSold' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const args = evt?.args as { grossProceeds: bigint; netProceeds: bigint; paymentAsset: Address } | undefined;

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
      `sellNft confirmed vault=${vaultId} nft=${params.nftContract}#${params.tokenId} ` +
        `gross=${args?.grossProceeds} net=${args?.netProceeds} tx=${result.hash}`
    );
    return {
      txHash: result.hash,
      grossProceeds: args?.grossProceeds ?? 0n,
      netProceeds: args?.netProceeds ?? 0n,
      paymentAsset: args?.paymentAsset ?? params.paymentAsset,
    };
  }

  /**
   * Drop a contribution record's protective hold on its NFT slot.
   *
   * A record whose cycle is Locked can never be refunded, so its units no longer
   * need to guard the slot against sale. Permissionless on-chain, but we submit
   * it with the admin key as a preflight step before {@link sellNft}.
   *
   * Idempotent from the caller's side: a record that is already released reverts,
   * which is treated as success.
   */
  async releaseNftRefundable(vaultId: string, contributionId: bigint): Promise<Hex | null> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmReleaseNftRefundable,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'NftRefundableReleased', count: 1 }],
      metadata: { contributionId: contributionId.toString() },
    });
    await this.transactionsRepository.save(adminTx);

    try {
      const result = await this.adminSigner.sendAndConfirm(
        {
          address: vaultAddress,
          abi: VAULT_ABI,
          functionName: 'releaseNftRefundable',
          args: [contributionId],
        },
        ['NftRefundableReleased'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
      await this.transactionsRepository.update(
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
      return result.hash;
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, 'releaseNftRefundable');
      throw err;
    }
  }

  /** Units of an NFT slot that still back a refundable contribution. */
  async slotRefundableUnits(vaultId: string, nftContract: Address, tokenId: bigint): Promise<bigint> {
    const vault = await this._requireEvmVault(vaultId);
    return this.contractReader.publicClient.readContract({
      address: vault.contract_address as Address,
      abi: VAULT_ABI,
      functionName: 'slotRefundableUnits',
      args: [nftContract, tokenId],
    }) as Promise<bigint>;
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
