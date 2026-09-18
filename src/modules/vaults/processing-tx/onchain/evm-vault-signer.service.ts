import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { decodeEventLog, encodeAbiParameters, keccak256, parseEther, toBytes, type Address, type Hex } from 'viem';

import { CreateVaultReq } from '../../dto/createVault.req';
import { TransactionsService } from '../offchain-tx/transactions.service';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { EvmChainConfig } from '@/modules/evm-chains/evm-chains.config';
import { EvmChainsService } from '@/modules/evm-chains/evm-chains.service';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ContributionWindowType, InvestmentWindowType, VaultStatus } from '@/types/vault.types';

// ---------------------------------------------------------------------------
// ABI parameter definitions — mirrors V4 VaultTypes.sol exactly.
// V4 changes vs V3:
//   - added `archetype` (bytes32) and `vaultDeployer` (address) for deployer-registry
//   - `admin` split into `creationApprover` (signs config, no runtime power)
//     and `authority` (runtime lifecycle power, two-step transferable)
// Keep in sync with the Solidity structs if the contract is ever upgraded.
// ---------------------------------------------------------------------------

const TIME_WINDOW = {
  type: 'tuple' as const,
  components: [
    { name: 'start', type: 'uint64' as const },
    { name: 'end', type: 'uint64' as const },
  ],
};

const CYCLE_CONFIG = {
  type: 'tuple' as const,
  components: [
    { name: 'assetWindow', ...TIME_WINDOW },
    { name: 'acquireWindow', ...TIME_WINDOW },
    { name: 'minAcquireThreshold', type: 'uint256' as const },
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
      { name: 'archetype', type: 'bytes32' as const },
      { name: 'vaultDeployer', type: 'address' as const },
      { name: 'creator', type: 'address' as const },
      { name: 'creationApprover', type: 'address' as const },
      { name: 'authority', type: 'address' as const },
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
  adaPairVtPerNativeUnit: bigint;
  assetWhitelist: Address[];
  contributorWhitelist: Address[];
}

export interface EvmVaultConfig {
  vaultId: Hex;
  archetype: Hex;
  vaultDeployer: Address;
  creator: Address;
  creationApprover: Address;
  authority: Address;
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
  /** Chain the signature is bound to — the client must send the tx there. */
  chainId: number;
  factoryAddress: Address;
}

const VAULT_CREATED_TOPIC = keccak256(toBytes('VaultCreated(bytes32,address,address,address,address)')).toLowerCase();

const VAULT_CREATED_EVENT = {
  type: 'event',
  name: 'VaultCreated',
  inputs: [
    { indexed: true, name: 'vaultId', type: 'bytes32' },
    { indexed: true, name: 'vault', type: 'address' },
    { indexed: true, name: 'creator', type: 'address' },
    { indexed: false, name: 'admin', type: 'address' },
    { indexed: false, name: 'vaultToken', type: 'address' },
  ],
} as const;

type VaultCreatedLog = { address?: string; topics: readonly string[]; data?: string };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class EvmVaultSignerService {
  private readonly logger = new Logger(EvmVaultSignerService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService,
    private readonly evmChains: EvmChainsService
  ) {}

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

    // The signature is bound to the vault's chain: the EIP-712 domain carries that
    // chain's id and factory, so a Robinhood signature is rejected on Arc and vice versa.
    const chain = this.evmChains.get(data.chainType);
    const cfg = this.buildVaultConfig(chain, evmVaultId, user.address as Address, data);

    const adminNonce = BigInt(Date.now());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const adminSignature = await this.signCreationAuthorization(chain, cfg, adminNonce, deadline);

    // Create transaction record for vault creation
    const transaction = await this.transactionsService.createTransaction({
      vault_id: dbVaultId,
      type: TransactionType.createVault,
      userId,
      assets: [],
      chain_id: chain.chainId,
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
      chainId: chain.chainId,
      factoryAddress: chain.factoryAddress as Address,
    };
  }

  /**
   * VaultCreated(bytes32 indexed vaultId, address indexed vault, address indexed creator, ...)
   * Only a log from this vault's factory, for this vault id and owner, counts.
   * Returns null if the receipt isn't readable yet.
   */
  private async readVaultAddressFromReceipt(
    vault: Vault,
    txHash: Hex,
    transactionId: string
  ): Promise<{ contractAddress: string | null; success: boolean } | null> {
    try {
      const chain = this.evmChains.forVault(vault);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = this.evmChains.publicClient(chain.chainId) as any;
      const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 15_000 });
      const success = receipt.status === 'success';

      await this.transactionsService.updateTransactionStatusById(
        transactionId,
        success ? TransactionStatus.confirmed : TransactionStatus.failed
      );

      if (!success) return { contractAddress: null, success: false };

      const contractAddress = this.contractAddressFromFactoryLog(vault, receipt.logs ?? []);
      return { contractAddress, success: true };
    } catch (error) {
      this.logger.warn(`Could not read VaultCreated from ${txHash}: ${(error as Error).message}`);
      return null;
    }
  }

  private decodeVaultCreated(log: VaultCreatedLog): { vaultId: Hex; vault: Address; creator: Address } | null {
    if (log.topics[0]?.toLowerCase() !== VAULT_CREATED_TOPIC) return null;
    try {
      const decoded = decodeEventLog({
        abi: [VAULT_CREATED_EVENT],
        data: (log.data || '0x') as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: { vaultId: Hex; vault: Address; creator: Address } };
      if (decoded.eventName !== 'VaultCreated') return null;
      return decoded.args;
    } catch {
      return null;
    }
  }

  /** Accept only VaultCreated from this vault's configured factory, matching id + owner. */
  private contractAddressFromFactoryLog(vault: Vault, logs: VaultCreatedLog[]): string | null {
    const factory = this.evmChains.forVault(vault).factoryAddress?.toLowerCase();
    const expectedVaultId = vault.evm_vault_id?.toLowerCase();
    const expectedCreator = vault.owner?.address?.toLowerCase();
    if (!factory || !expectedVaultId || !expectedCreator) return null;

    for (const log of logs) {
      if (log.address?.toLowerCase() !== factory) continue;
      const args = this.decodeVaultCreated(log);
      if (!args) continue;
      if (args.vaultId.toLowerCase() !== expectedVaultId) continue;
      if (args.creator.toLowerCase() !== expectedCreator) continue;
      return args.vault.toLowerCase();
    }
    return null;
  }

  async confirmVaultCreation(userId: string, dbVaultId: string, txHash: string, transactionId: string): Promise<void> {
    const vault = await this.vaultsRepository.findOne({
      where: { id: dbVaultId },
      relations: ['owner'],
    });
    if (!vault) throw new BadRequestException('Vault not found');
    if (vault.owner.id !== userId) throw new BadRequestException('Not the vault owner');

    try {
      await this.transactionsService.updateTransactionHash(transactionId, txHash);

      const receipt = await this.readVaultAddressFromReceipt(vault, txHash as Hex, transactionId);
      if (!receipt) {
        throw new BadRequestException(
          'Timed out waiting for the vault creation receipt. Retry publish once the transaction is mined.'
        );
      }
      if (!receipt.success) {
        throw new BadRequestException('Vault creation transaction reverted on-chain. Recreate the vault.');
      }
      if (!receipt.contractAddress) {
        throw new BadRequestException('VaultCreated event not found in the creation receipt.');
      }

      vault.contract_address = receipt.contractAddress;
      vault.publication_hash = txHash;
      vault.last_update_tx_hash = txHash;
      vault.vault_status = VaultStatus.published;

      // Arc has no Alchemy webhook, so the published → contribution/acquire
      // flip that Robinhood gets from handleCreateVaultConfirmation must happen here.
      const now = new Date();
      if (vault.is_acquire_only) {
        if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
          vault.vault_status = VaultStatus.acquire;
          vault.acquire_phase_start = now;
        }
      } else if (vault.contribution_open_window_type === ContributionWindowType.uponVaultLaunch) {
        vault.vault_status = VaultStatus.contribution;
        vault.contribution_phase_start = now;
      }

      await this.vaultsRepository.save(vault);

      this.logger.log(
        `EVM vault confirmed — dbId=${dbVaultId} addr=${receipt.contractAddress} status=${vault.vault_status} txHash=${txHash}`
      );
    } catch (error) {
      if (!(error instanceof BadRequestException)) {
        await this.transactionsService.updateTransactionStatusById(transactionId, TransactionStatus.failed);
      }
      this.logger.error(`Failed to confirm vault creation: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Update vault contract address from VaultCreated event (called by webhook handler).
   * Only logs emitted by the vault's configured factory, for its evm_vault_id and owner, apply.
   */
  async updateVaultFromCreatedEvent(
    txHash: string,
    log: { address?: string; topics: string[]; data: string }
  ): Promise<void> {
    const args = this.decodeVaultCreated(log);
    if (!args) {
      this.logger.warn(`VaultCreated log in ${txHash} could not be decoded`);
      return;
    }

    const vault = await this.vaultsRepository.findOne({
      where: { evm_vault_id: args.vaultId },
      relations: ['owner'],
    });

    if (!vault) {
      this.logger.debug(`VaultCreated event for unknown evmVaultId=${args.vaultId} (might be external vault)`);
      return;
    }

    const contractAddress = this.contractAddressFromFactoryLog(vault, [log]);
    if (!contractAddress) {
      this.logger.warn(
        `Ignoring VaultCreated in ${txHash} for vault ${vault.id}: emitter ${log.address} failed factory/id/owner checks`
      );
      return;
    }

    vault.contract_address = contractAddress;
    await this.vaultsRepository.save(vault);

    this.logger.log(
      `Vault contract address updated from VaultCreated event — ` +
        `dbId=${vault.id} evmVaultId=${args.vaultId} vaultAddr=${contractAddress} txHash=${txHash}`
    );
  }

  // --------------------------------------------------------------------------
  // EIP-712 signing
  // --------------------------------------------------------------------------

  private async signCreationAuthorization(
    chain: EvmChainConfig,
    cfg: EvmVaultConfig,
    adminNonce: bigint,
    deadline: bigint
  ): Promise<Hex> {
    const configHash = this.computeConfigHash(cfg);

    const account = this.evmChains.adminAccount(chain.chainId);

    const signature = await account.signTypedData({
      domain: {
        name: 'L4VA-VaultFactory',
        version: '1',
        chainId: chain.chainId,
        verifyingContract: chain.factoryAddress as Address,
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

  private buildVaultConfig(
    chain: EvmChainConfig,
    evmVaultId: Hex,
    creatorAddress: Address,
    data: CreateVaultReq
  ): EvmVaultConfig {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const oneDay = BigInt(86400);
    const isAcquireOnly = Boolean(data.isAcquireOnly);

    // Asset (contribution) window — default 7 days from now if not specified.
    // Acquire-only vaults have no contribution phase. Vault._validateWindow
    // rejects end <= start unless both are 0 (the closed/unset sentinel).
    const assetWindowStart = isAcquireOnly ? 0n : now;
    const assetWindowEnd = isAcquireOnly
      ? 0n
      : data.contributionDuration
        ? now + BigInt(Math.floor(Number(data.contributionDuration) / 1000))
        : now + oneDay * 7n;

    // Contribution-only vaults (0% tokens for acquirers) skip the acquire window.
    // { start: 0, end: 0 } is treated as already closed by the lifecycle cron.
    const skipsAcquirePhase = Number(data.tokensForAcquires) === 0;

    // The acquire window opens when the phase does — after the contribution window
    // closes, or at the configured custom time. Starting it at creation made the
    // on-chain window expire before the phase even opened (the contract then reverts
    // with OutsideAcquireWindow), which short windows hit every time.
    const acquireWindowStart = skipsAcquirePhase
      ? 0n
      : data.acquireOpenWindowType === InvestmentWindowType.custom && data.acquireOpenWindowTime
        ? BigInt(Math.floor(new Date(data.acquireOpenWindowTime).getTime() / 1000))
        : isAcquireOnly
          ? now
          : assetWindowEnd;
    const acquireWindowEnd = skipsAcquirePhase
      ? 0n
      : acquireWindowStart +
        (data.acquireWindowDuration ? BigInt(Math.floor(Number(data.acquireWindowDuration) / 1000)) : oneDay * 7n);

    let minAcquireThreshold = 0n;
    if (data.minAcquireThreshold != null && Number(data.minAcquireThreshold) > 0) {
      try {
        minAcquireThreshold = parseEther(String(data.minAcquireThreshold));
      } catch {
        throw new BadRequestException('Invalid minAcquireThreshold');
      }
    }

    return {
      vaultId: evmVaultId,
      archetype: '0xaf85f1959fc2aa8b532f1218046c19fa780e1da2664cec6949ee750524d8ccfd' as Hex, // BatchVaultDeployer.BATCH = keccak256("L4VA.Vault.Batch")
      vaultDeployer: chain.batchDeployerAddress as Address,
      creator: creatorAddress,
      creationApprover: chain.adminAddress as Address,
      authority: chain.adminAddress as Address,
      mintingKey: chain.mintingSignerAddress as Address,
      treasury: chain.treasuryAddress as Address,
      vtName: data.name,
      vtSymbol: (data.vaultTokenTicker || 'VT').toUpperCase(),
      vtDecimals: 18,
      initialCycle: {
        assetWindow: { start: assetWindowStart, end: assetWindowEnd },
        acquireWindow: { start: acquireWindowStart, end: acquireWindowEnd },
        minAcquireThreshold,
        // V3: LP-pair multiplier only. Contribution-time rates are gone —
        // final VT / native allocations are committed off-chain and
        // published on-chain as a Merkle root at `closeCycle`.
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
