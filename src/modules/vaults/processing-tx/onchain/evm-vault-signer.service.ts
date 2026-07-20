import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CreateVaultReq } from '../../dto/createVault.req';
import { TransactionsService } from '../offchain-tx/transactions.service';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

// ---------------------------------------------------------------------------
// ABI parameter definitions — mirrors VaultTypes.sol exactly.
// Keep in sync with the Solidity structs if the contract is ever upgraded.
// ---------------------------------------------------------------------------

const TIME_WINDOW = {
  type: 'tuple' as const,
  components: [
    { name: 'start', type: 'uint64' as const },
    { name: 'end', type: 'uint64' as const },
  ],
};

const ASSET_VT_RATE = {
  type: 'tuple' as const,
  components: [
    { name: 'vtPerAssetUnit', type: 'uint256' as const },
    { name: 'assetDecimals', type: 'uint8' as const },
    { name: 'version', type: 'uint32' as const },
    { name: 'enabled', type: 'bool' as const },
  ],
};

const NFT_COLLECTION_RATE = {
  type: 'tuple' as const,
  components: [
    { name: 'vtPerToken', type: 'uint256' as const },
    { name: 'version', type: 'uint32' as const },
    { name: 'enabled', type: 'bool' as const },
  ],
};

const ASSET_NATIVE_RATE = {
  type: 'tuple' as const,
  components: [
    { name: 'nativePerAssetUnit', type: 'uint256' as const },
    { name: 'assetDecimals', type: 'uint8' as const },
    { name: 'version', type: 'uint32' as const },
    { name: 'enabled', type: 'bool' as const },
  ],
};

const NFT_COLLECTION_NATIVE_RATE = {
  type: 'tuple' as const,
  components: [
    { name: 'nativePerToken', type: 'uint256' as const },
    { name: 'version', type: 'uint32' as const },
    { name: 'enabled', type: 'bool' as const },
  ],
};

const CYCLE_CONFIG = {
  type: 'tuple' as const,
  components: [
    { name: 'assetWindow', ...TIME_WINDOW },
    { name: 'acquireWindow', ...TIME_WINDOW },
    { name: 'minAcquireThreshold', type: 'uint256' as const },
    { name: 'nativeRate', ...ASSET_VT_RATE },
    {
      name: 'erc20Rates',
      type: 'tuple[]' as const,
      components: [
        { name: 'asset', type: 'address' as const },
        { name: 'rate', ...ASSET_VT_RATE },
      ],
    },
    {
      name: 'erc1155Rates',
      type: 'tuple[]' as const,
      components: [
        { name: 'asset', type: 'address' as const },
        { name: 'rate', ...ASSET_VT_RATE },
      ],
    },
    {
      name: 'nftCollectionRates',
      type: 'tuple[]' as const,
      components: [
        { name: 'collection', type: 'address' as const },
        { name: 'rate', ...NFT_COLLECTION_RATE },
      ],
    },
    {
      name: 'nftTokenIdOverrides',
      type: 'tuple[]' as const,
      components: [
        { name: 'collection', type: 'address' as const },
        { name: 'tokenId', type: 'uint256' as const },
        { name: 'vtEntitlement', type: 'uint256' as const },
      ],
    },
    {
      name: 'erc20NativeRates',
      type: 'tuple[]' as const,
      components: [
        { name: 'asset', type: 'address' as const },
        { name: 'rate', ...ASSET_NATIVE_RATE },
      ],
    },
    {
      name: 'erc1155NativeRates',
      type: 'tuple[]' as const,
      components: [
        { name: 'asset', type: 'address' as const },
        { name: 'rate', ...ASSET_NATIVE_RATE },
      ],
    },
    {
      name: 'nftNativeCollectionRates',
      type: 'tuple[]' as const,
      components: [
        { name: 'collection', type: 'address' as const },
        { name: 'rate', ...NFT_COLLECTION_NATIVE_RATE },
      ],
    },
    {
      name: 'nftNativeTokenIdOverrides',
      type: 'tuple[]' as const,
      components: [
        { name: 'collection', type: 'address' as const },
        { name: 'tokenId', type: 'uint256' as const },
        { name: 'nativePayoutEntitlement', type: 'uint256' as const },
      ],
    },
    { name: 'adaPairVtPerNativeUnit', type: 'uint256' as const },
    { name: 'assetWhitelist', type: 'address[]' as const },
    { name: 'contributorWhitelist', type: 'address[]' as const },
  ],
};

/** ABI type for the full VaultConfig struct — used by encodeAbiParameters. */
const VAULT_CONFIG_ABI = [
  {
    name: 'cfg',
    type: 'tuple' as const,
    components: [
      { name: 'vaultId', type: 'bytes32' as const },
      { name: 'creator', type: 'address' as const },
      { name: 'admin', type: 'address' as const },
      { name: 'mintingKey', type: 'address' as const },
      { name: 'treasury', type: 'address' as const },
      { name: 'vtName', type: 'string' as const },
      { name: 'vtSymbol', type: 'string' as const },
      { name: 'vtDecimals', type: 'uint8' as const },
      { name: 'initialCycle', ...CYCLE_CONFIG },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvmCycleConfig {
  assetWindow: { start: bigint; end: bigint };
  acquireWindow: { start: bigint; end: bigint };
  minAcquireThreshold: bigint;
  nativeRate: { vtPerAssetUnit: bigint; assetDecimals: number; version: number; enabled: boolean };
  erc20Rates: Array<{
    asset: Address;
    rate: { vtPerAssetUnit: bigint; assetDecimals: number; version: number; enabled: boolean };
  }>;
  erc1155Rates: Array<{
    asset: Address;
    rate: { vtPerAssetUnit: bigint; assetDecimals: number; version: number; enabled: boolean };
  }>;
  nftCollectionRates: Array<{ collection: Address; rate: { vtPerToken: bigint; version: number; enabled: boolean } }>;
  nftTokenIdOverrides: Array<{ collection: Address; tokenId: bigint; vtEntitlement: bigint }>;
  erc20NativeRates: Array<{
    asset: Address;
    rate: { nativePerAssetUnit: bigint; assetDecimals: number; version: number; enabled: boolean };
  }>;
  erc1155NativeRates: Array<{
    asset: Address;
    rate: { nativePerAssetUnit: bigint; assetDecimals: number; version: number; enabled: boolean };
  }>;
  nftNativeCollectionRates: Array<{
    collection: Address;
    rate: { nativePerToken: bigint; version: number; enabled: boolean };
  }>;
  nftNativeTokenIdOverrides: Array<{ collection: Address; tokenId: bigint; nativePayoutEntitlement: bigint }>;
  adaPairVtPerNativeUnit: bigint;
  assetWhitelist: Address[];
  contributorWhitelist: Address[];
}

export interface EvmVaultConfig {
  vaultId: Hex;
  creator: Address;
  admin: Address;
  mintingKey: Address;
  treasury: Address;
  vtName: string;
  vtSymbol: string;
  vtDecimals: number;
  initialCycle: EvmCycleConfig;
}

export interface EvmCreationPayload {
  dbVaultId: string;
  transactionId: string;
  evmVaultConfig: EvmVaultConfig;
  adminNonce: string;
  deadline: number;
  adminSignature: Hex;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class EvmVaultSignerService {
  private readonly logger = new Logger(EvmVaultSignerService.name);

  private readonly factoryAddress: Address;
  private readonly adminAddress: Address;
  private readonly mintingSignerAddress: Address;
  private readonly treasuryAddress: Address;
  private readonly chainId: number;
  private readonly adminPrivateKey: Hex;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService
  ) {
    this.factoryAddress = this.configService.get<string>('EVM_FACTORY_ADDRESS') as Address;
    this.adminAddress = this.configService.get<string>('EVM_ADMIN_ADDRESS') as Address;
    this.mintingSignerAddress = this.configService.get<string>('EVM_MINTING_SIGNER_ADDRESS') as Address;
    this.treasuryAddress = this.configService.get<string>('EVM_TREASURY_ADDRESS') as Address;
    this.chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '46630');
    this.adminPrivateKey = this.configService.get<string>('EVM_ADMIN_PRIVATE_KEY') as Hex;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Prepare EVM vault creation with an existing vault entity (vault already saved in DB).
   * Vault creation is now handled by vaults.service.ts to consolidate all vault creation logic.
   */
  async prepareVaultCreationWithExistingVault(
    userId: string,
    dbVaultId: string,
    evmVaultId: Hex,
    data: CreateVaultReq
  ): Promise<Omit<EvmCreationPayload, 'dbVaultId'>> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'address'],
    });
    if (!user) throw new BadRequestException('User not found');

    const cfg = this.buildVaultConfig(evmVaultId, user.address as Address, data);

    const adminNonce = BigInt(Date.now());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const adminSignature = await this.signCreationAuthorization(cfg, adminNonce, deadline);

    // Create transaction record for vault creation
    const transaction = await this.transactionsService.createTransaction({
      vault_id: dbVaultId,
      type: TransactionType.createVault,
      userId,
      assets: [],
    });

    this.logger.log(
      `EVM vault prepared (existing) — dbId=${dbVaultId} evmVaultId=${cfg.vaultId} txId=${transaction.id}`
    );

    return {
      transactionId: transaction.id,
      evmVaultConfig: this.serializeBigInts(cfg) as EvmVaultConfig,
      adminNonce: adminNonce.toString(),
      deadline: Number(deadline),
      adminSignature,
    };
  }

  async confirmVaultCreation(userId: string, dbVaultId: string, txHash: string, transactionId: string): Promise<void> {
    const vault = await this.vaultsRepository.findOne({
      where: { id: dbVaultId },
      relations: ['owner'],
    });
    if (!vault) throw new BadRequestException('Vault not found');
    if (vault.owner.id !== userId) throw new BadRequestException('Not the vault owner');

    try {
      // Update transaction record with the tx hash
      await this.transactionsService.updateTransactionHash(transactionId, txHash);

      // Mark vault as published. The actual vault contract address will be filled
      // when the VaultCreated event arrives via webhook (see updateVaultFromCreatedEvent).
      vault.vault_status = VaultStatus.published;
      vault.publication_hash = txHash;
      vault.last_update_tx_hash = txHash;
      // Note: contract_address remains null/factory until webhook updates it
      await this.vaultsRepository.save(vault);

      this.logger.log(`EVM vault confirmed — dbId=${dbVaultId} txHash=${txHash} txId=${transactionId}`);
    } catch (error) {
      // Update transaction status to failed on error
      await this.transactionsService.updateTransactionStatusById(transactionId, TransactionStatus.failed);
      this.logger.error(`Failed to confirm vault creation: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Update vault contract address from VaultCreated event (called by webhook handler).
   * VaultCreated(bytes32 indexed vaultId, address indexed vault, address indexed creator, address admin, address vaultToken)
   * topics[0] = event signature, topics[1] = vaultId, topics[2] = vault address, topics[3] = creator
   * data = abi.encode(admin, vaultToken)
   */
  async updateVaultFromCreatedEvent(txHash: string, topics: string[], _data: string): Promise<void> {
    if (topics.length < 4) {
      this.logger.warn(`VaultCreated event has insufficient topics: ${topics.length}`);
      return;
    }

    const evmVaultId = topics[1]; // indexed bytes32
    const vaultAddress = '0x' + topics[2].slice(-40); // indexed address (last 20 bytes)

    const vault = await this.vaultsRepository.findOne({
      where: { evm_vault_id: evmVaultId },
    });

    if (!vault) {
      this.logger.debug(`VaultCreated event for unknown evmVaultId=${evmVaultId} (might be external vault)`);
      return;
    }

    // Update the vault contract address
    vault.contract_address = vaultAddress.toLowerCase();
    await this.vaultsRepository.save(vault);

    this.logger.log(
      `Vault contract address updated from VaultCreated event — ` +
        `dbId=${vault.id} evmVaultId=${evmVaultId} vaultAddr=${vaultAddress} txHash=${txHash}`
    );
  }

  // --------------------------------------------------------------------------
  // EIP-712 signing
  // --------------------------------------------------------------------------

  private async signCreationAuthorization(cfg: EvmVaultConfig, adminNonce: bigint, deadline: bigint): Promise<Hex> {
    const configHash = this.computeConfigHash(cfg);

    const account = privateKeyToAccount(this.adminPrivateKey);

    const signature = await account.signTypedData({
      domain: {
        name: 'L4VA-VaultFactory',
        version: '1',
        chainId: this.chainId,
        verifyingContract: this.factoryAddress,
      },
      types: {
        CreationAuthorization: [
          { name: 'creator', type: 'address' },
          { name: 'configHash', type: 'bytes32' },
          { name: 'adminNonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'CreationAuthorization',
      message: {
        creator: cfg.creator,
        configHash,
        adminNonce,
        deadline,
      },
    });

    return signature;
  }

  /** keccak256(abi.encode(cfg)) — mirrors VaultCreationAuthorizations.configHash(). */
  private computeConfigHash(cfg: EvmVaultConfig): Hex {
    const encoded = encodeAbiParameters(VAULT_CONFIG_ABI, [cfg as any]);
    return keccak256(encoded);
  }

  // --------------------------------------------------------------------------
  // VaultConfig builder
  // --------------------------------------------------------------------------

  private buildVaultConfig(evmVaultId: Hex, creatorAddress: Address, data: CreateVaultReq): EvmVaultConfig {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const oneDay = BigInt(86400);

    // Asset (contribution) window — default 7 days from now if not specified
    const assetWindowStart = now;
    const assetWindowEnd = data.contributionDuration
      ? now + BigInt(Math.floor(Number(data.contributionDuration) / 1000))
      : now + oneDay * 7n;

    // Acquire window — default 7 days from now if not specified
    const acquireWindowStart = now;
    const acquireWindowEnd = data.acquireWindowDuration
      ? now + BigInt(Math.floor(Number(data.acquireWindowDuration) / 1000))
      : now + oneDay * 7n;

    return {
      vaultId: evmVaultId,
      creator: creatorAddress,
      admin: this.adminAddress,
      mintingKey: this.mintingSignerAddress,
      treasury: this.treasuryAddress,
      vtName: data.name,
      vtSymbol: (data.vaultTokenTicker || 'VT').toUpperCase(),
      vtDecimals: 18,
      initialCycle: {
        assetWindow: { start: assetWindowStart, end: assetWindowEnd },
        acquireWindow: { start: acquireWindowStart, end: acquireWindowEnd },
        minAcquireThreshold: 0n,
        nativeRate: {
          vtPerAssetUnit: 1000n * 10n ** 18n, // 1000 VT per ETH — admin can update later
          assetDecimals: 18,
          version: 0,
          enabled: true,
        },
        erc20Rates: [],
        erc1155Rates: [],
        nftCollectionRates: [],
        nftTokenIdOverrides: [],
        erc20NativeRates: [],
        erc1155NativeRates: [],
        nftNativeCollectionRates: [],
        nftNativeTokenIdOverrides: [],
        adaPairVtPerNativeUnit: 0n,
        assetWhitelist: [],
        contributorWhitelist: [],
      },
    };
  }

  // --------------------------------------------------------------------------
  // Serialization helpers
  // --------------------------------------------------------------------------

  /** Recursively convert BigInt values to strings so Express can JSON.stringify the response.
   *  The frontend's normalizeBigInts() in useCreateEvmVault.js converts them back before wagmi. */
  private serializeBigInts(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map(v => this.serializeBigInts(v));
    if (typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, this.serializeBigInts(v)])
      );
    }
    return obj;
  }
}
