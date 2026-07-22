import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { AssetType } from '@/types/asset.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

/**
 * Numeric values mirror the on-chain enum in
 * `vault-contract-solidity/src/libraries/VaultTypes.sol#AssetKind`.
 */
export enum EvmAssetKind {
  Native = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
}

const KIND_TO_FUNCTION: Record<EvmAssetKind, string> = {
  [EvmAssetKind.Native]: 'contributeNative',
  [EvmAssetKind.ERC20]: 'contributeERC20',
  [EvmAssetKind.ERC721]: 'contributeERC721',
  [EvmAssetKind.ERC1155]: 'contributeERC1155',
};

export interface EvmContributionAuthorization {
  cycleId: string;
  contributor: Address;
  kind: EvmAssetKind;
  asset: Address;
  tokenId: string;
  amount: string;
  nonce: string;
  deadline: number;
}

export interface EvmContributionCall {
  /** Index into the transaction metadata assets array. */
  assetIndex: number;
  /** Solidity function to invoke on the Vault contract. */
  functionName: string;
  /** EIP-712 authorization struct — send to the contract as the first argument. */
  authorization: EvmContributionAuthorization;
  /** 65-byte compact ECDSA signature over the authorization digest. */
  signature: Hex;
  /**
   * For ERC20 / ERC721 / ERC1155 the caller must approve() (or setApprovalForAll())
   * the vault address before invoking the contribute function.
   */
  approval:
    | { required: false }
    | { required: true; standard: 'ERC20' | 'ERC721' | 'ERC1155'; token: Address; amountOrTokenId: string };
  /** Native ETH value that must be forwarded with the call (contributeNative only). */
  value: string;
}

export interface EvmContributionPrepareResponse {
  txId: string;
  vaultAddress: Address;
  chainId: number;
  mintingSigner: Address;
  calls: EvmContributionCall[];
}

// ---------------------------------------------------------------------------
// EIP-712 typed data — MUST mirror
// `vault-contract-solidity/src/libraries/VaultAuthorizations.sol`.
// ---------------------------------------------------------------------------

const DOMAIN_NAME = 'L4VA Vault';
const DOMAIN_VERSION = '3';

const CONTRIBUTION_TYPES = {
  ContributionAuthorization: [
    { name: 'cycleId', type: 'uint256' },
    { name: 'contributor', type: 'address' },
    { name: 'kind', type: 'uint8' },
    { name: 'asset', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * V3 EVM contribution flow.
 *
 *  1. Frontend calls `POST /contribute/:vaultId` (existing Cardano endpoint).
 *     A `Transaction` row with `metadata = [...assets]` is created.
 *  2. Frontend calls `POST /blockchain/evm/contribution/prepare { txId }`
 *     (this service). We sign one EIP-712 `ContributionAuthorization` per
 *     asset using the vault's `mintingKey` private key, and return everything
 *     the wallet needs to submit N on-chain calls.
 *  3. Frontend loops through `calls`, sends approve() + contributeXxx() per
 *     asset via wagmi, awaits each receipt.
 *  4. Frontend calls `POST /blockchain/evm/contribution/confirm
 *     { txId, txHash }` — we persist the primary tx hash, create the Asset
 *     rows from `metadata`, and let the Alchemy webhook handle final
 *     status confirmation.
 */
@Injectable()
export class EvmVaultContributionService {
  private readonly logger = new Logger(EvmVaultContributionService.name);

  private readonly chainId: number;
  private readonly mintingSignerPrivateKey: Hex;
  private readonly mintingSignerAddress: Address;
  /** Validity window for issued authorization signatures. */
  private readonly AUTH_VALIDITY_SECONDS = 60 * 60; // 1 hour
  /** V3 vault opens cycleId=1 immediately after createVault. */
  private readonly DEFAULT_CYCLE_ID = 1n;

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService
  ) {
    this.chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '46630');
    this.mintingSignerPrivateKey = this.configService.get<string>('EVM_MINTING_SIGNER_PRIVATE_KEY') as Hex;
    this.mintingSignerAddress = this.configService.get<string>('EVM_MINTING_SIGNER_ADDRESS') as Address;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async prepareContribution(txId: string, userId: string): Promise<EvmContributionPrepareResponse> {
    const transaction = await this.transactionRepository.findOne({
      where: { id: txId },
      relations: ['user'],
    });
    if (!transaction) throw new NotFoundException('Transaction not found');
    if (transaction.user_id !== userId) throw new BadRequestException('Transaction does not belong to caller');
    if (transaction.type !== TransactionType.contribute) {
      throw new BadRequestException('Transaction is not a contribution');
    }

    const vault = await this.vaultsRepository.findOne({ where: { id: transaction.vault_id } });
    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException('Vault is not an EVM (Robinhood) vault');
    }
    if (!vault.contract_address) {
      throw new BadRequestException('Vault contract address is not set — the vault may not yet be created on-chain');
    }

    const contributor = transaction.user?.address as Address | undefined;
    if (!contributor) throw new BadRequestException('User has no EVM address on record');

    const rawAssets = (transaction.metadata as any[]) || [];
    if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
      throw new BadRequestException('Transaction has no assets to contribute');
    }

    const vaultAddress = vault.contract_address as Address;
    const deadline = Math.floor(Date.now() / 1000) + this.AUTH_VALIDITY_SECONDS;

    const calls: EvmContributionCall[] = [];
    for (let i = 0; i < rawAssets.length; i++) {
      const asset = rawAssets[i];
      const kind = this.resolveAssetKind(asset);
      const assetAddress = this.resolveAssetAddress(kind, asset);
      const tokenId = this.resolveTokenId(kind, asset);
      const amount = this.resolveAmount(kind, asset);

      // Per-asset nonce derived from txId + index. Deterministic (idempotent
      // if the user retries with the same txId) yet still unique on-chain.
      const nonce = this.deriveNonce(txId, i);

      const authorization: EvmContributionAuthorization = {
        cycleId: this.DEFAULT_CYCLE_ID.toString(),
        contributor,
        kind,
        asset: assetAddress,
        tokenId: tokenId.toString(),
        amount: amount.toString(),
        nonce: nonce.toString(),
        deadline,
      };

      const signature = await this.signAuthorization(vaultAddress, authorization);

      calls.push({
        assetIndex: i,
        functionName: KIND_TO_FUNCTION[kind],
        authorization,
        signature,
        approval: this.buildApproval(kind, assetAddress, amount, tokenId),
        value: kind === EvmAssetKind.Native ? amount.toString() : '0',
      });
    }

    return {
      txId,
      vaultAddress,
      chainId: this.chainId,
      mintingSigner: this.mintingSignerAddress,
      calls,
    };
  }

  /**
   * Frontend calls this once, after all N on-chain contributions have been
   * successfully submitted. Persists the primary tx hash (the last one is
   * fine — the webhook confirms all events tied to this vault) and creates
   * the Asset rows from the transaction metadata.
   */
  async confirmContribution(
    txId: string,
    txHash: string,
    userId: string,
    childTxHashes?: string[]
  ): Promise<{ success: boolean; txHash: string }> {
    const transaction = await this.transactionRepository.findOne({ where: { id: txId } });
    if (!transaction) throw new NotFoundException('Transaction not found');
    if (transaction.user_id !== userId) throw new BadRequestException('Transaction does not belong to caller');
    if (transaction.type !== TransactionType.contribute) {
      throw new BadRequestException('Transaction is not a contribution');
    }

    // createAssets consumes metadata, so preserve child hashes on the row
    // BEFORE createAssets clears metadata.
    if (childTxHashes && childTxHashes.length > 0) {
      await this.transactionRepository.update(
        { id: txId },
        {
          metadata: { ...((transaction.metadata as object) || {}), evmChildTxHashes: childTxHashes },
        }
      );
    }

    try {
      await this.transactionsService.createAssets(txId);
      await this.transactionsService.updateTransactionHash(txId, txHash);
      this.logger.log(`EVM contribution confirmed — txId=${txId} txHash=${txHash}`);
      return { success: true, txHash };
    } catch (err) {
      await this.transactionsService.updateTransactionStatusById(txId, TransactionStatus.failed);
      this.logger.error(`Failed to confirm EVM contribution ${txId}: ${(err as Error).message}`);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async signAuthorization(vaultAddress: Address, auth: EvmContributionAuthorization): Promise<Hex> {
    const account = privateKeyToAccount(this.mintingSignerPrivateKey);
    return account.signTypedData({
      domain: {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId: this.chainId,
        verifyingContract: vaultAddress,
      },
      types: CONTRIBUTION_TYPES,
      primaryType: 'ContributionAuthorization',
      message: {
        cycleId: BigInt(auth.cycleId),
        contributor: auth.contributor,
        kind: auth.kind,
        asset: auth.asset,
        tokenId: BigInt(auth.tokenId),
        amount: BigInt(auth.amount),
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
      },
    });
  }

  private resolveAssetKind(asset: any): EvmAssetKind {
    // Explicit override wins.
    const explicit = (asset.standard || asset.metadata?.standard || asset.metadata?.onchainMetadata?.tokenType) as
      | string
      | undefined;
    if (explicit) {
      const upper = String(explicit).toUpperCase();
      if (upper === 'ERC20') return EvmAssetKind.ERC20;
      if (upper === 'ERC721') return EvmAssetKind.ERC721;
      if (upper === 'ERC1155') return EvmAssetKind.ERC1155;
      if (upper === 'NATIVE' || upper === 'ETH') return EvmAssetKind.Native;
    }

    // Fall back to legacy AssetType.
    if (asset.type === AssetType.ADA || asset.type === 'ada') return EvmAssetKind.Native;
    if (asset.type === AssetType.FT || asset.type === 'ft') return EvmAssetKind.ERC20;
    if (asset.type === AssetType.NFT || asset.type === 'nft') return EvmAssetKind.ERC721;

    throw new BadRequestException(`Cannot resolve EVM AssetKind for asset: ${JSON.stringify(asset)}`);
  }

  private resolveAssetAddress(kind: EvmAssetKind, asset: any): Address {
    if (kind === EvmAssetKind.Native) return '0x0000000000000000000000000000000000000000';
    const raw = (asset.policyId || asset.metadata?.policyId || '') as string;
    if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      throw new BadRequestException(`Invalid EVM asset address for kind=${EvmAssetKind[kind]}: ${raw}`);
    }
    return raw.toLowerCase() as Address;
  }

  private resolveTokenId(kind: EvmAssetKind, asset: any): bigint {
    if (kind === EvmAssetKind.Native || kind === EvmAssetKind.ERC20) return 0n;
    // ERC721 / ERC1155: tokenId is in `assetName` (numeric string) or
    // `metadata.onchainMetadata.tokenId`.
    const raw = asset.assetName ?? asset.metadata?.onchainMetadata?.tokenId ?? asset.tokenId;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new BadRequestException(`Missing tokenId for ${EvmAssetKind[kind]} contribution`);
    }
    try {
      return BigInt(raw);
    } catch {
      throw new BadRequestException(`Invalid tokenId for ${EvmAssetKind[kind]} contribution: ${raw}`);
    }
  }

  private resolveAmount(kind: EvmAssetKind, asset: any): bigint {
    if (kind === EvmAssetKind.ERC721) return 1n;

    // Frontend sends raw blockchain quantities (already decimal-scaled for FTs
    // and wei for native). See ContributeModal.handleContribute.
    const raw = asset.quantity ?? asset.amount ?? 0;
    let value: bigint;
    try {
      // Number → string → BigInt (handles both integer numbers and numeric strings)
      value = BigInt(typeof raw === 'number' ? Math.trunc(raw) : String(raw));
    } catch {
      throw new BadRequestException(`Invalid amount for ${EvmAssetKind[kind]} contribution: ${raw}`);
    }
    if (value <= 0n) throw new BadRequestException(`Amount must be > 0 for ${EvmAssetKind[kind]} contribution`);
    return value;
  }

  private buildApproval(
    kind: EvmAssetKind,
    asset: Address,
    amount: bigint,
    tokenId: bigint
  ): EvmContributionCall['approval'] {
    switch (kind) {
      case EvmAssetKind.ERC20:
        return { required: true, standard: 'ERC20', token: asset, amountOrTokenId: amount.toString() };
      case EvmAssetKind.ERC721:
        return { required: true, standard: 'ERC721', token: asset, amountOrTokenId: tokenId.toString() };
      case EvmAssetKind.ERC1155:
        return { required: true, standard: 'ERC1155', token: asset, amountOrTokenId: '0' };
      case EvmAssetKind.Native:
      default:
        return { required: false };
    }
  }

  /** Deterministic per-(txId, index) nonce so retries collapse on-chain to the same slot. */
  private deriveNonce(txId: string, index: number): bigint {
    const digest = keccak256(toBytes(`${txId}:${index}`));
    return BigInt(digest);
  }
}
