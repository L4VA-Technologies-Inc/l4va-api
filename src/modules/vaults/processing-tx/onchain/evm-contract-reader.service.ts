import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, fallback, http, type Address, type Hex } from 'viem';

import { PROTOCOL_FEE_CONFIG_ABI, type ProtocolFeeType } from './protocol-fee-config.abi';
import { EvmContributionStatus, EvmCycleStatus, VAULT_ABI } from './vault.abi';

/** Alchemy subdomain per Robinhood chain id, used to build the default backup RPC. */
const ALCHEMY_HOST_BY_CHAIN_ID: Record<number, string> = {
  4663: 'robinhood-mainnet',
  46630: 'robinhood-testnet',
};

/** Shape returned by Vault.getCycle(cycleId). Mirrors CycleView in Vault.sol. */
export interface OnchainCycleView {
  status: number;
  assetWindow: { start: bigint; end: bigint };
  acquireWindow: { start: bigint; end: bigint };
  openedAt: bigint;
  nativeCollected: bigint;
  minAcquireThreshold: bigint;
  adaPairVtPerNativeUnit: bigint;
  allocationRoot: Hex;
  valuationHash: Hex;
  totalVtAllocation: bigint;
  totalNativeAllocation: bigint;
  claimedVt: bigint;
  claimedNative: bigint;
}

/** Shape returned by Vault.getContribution(id). Mirrors Contribution in VaultTypes.sol. */
export interface OnchainContributionView {
  cycleId: bigint;
  contributor: Address;
  kind: number;
  asset: Address;
  tokenId: bigint;
  amount: bigint;
  status: number;
  authDigest: Hex;
  authNonce: bigint;
  depositedAt: bigint;
}

/**
 * Read-only viem client wrapper. Used by prepare-tx paths to verify on-chain
 * state BEFORE broadcasting, and by the webhook layer for cross-checks.
 *
 * Never mutates chain state. All writes go through EvmAdminSigner.
 *
 * Uses `any` for the viem PublicClient because the generic parameters differ
 * between viem versions and adding constraints here provides little benefit —
 * the return types below are strictly typed for callers.
 */
@Injectable()
export class EvmContractReader {
  private readonly logger = new Logger(EvmContractReader.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  readonly chainId: number;

  constructor(private readonly configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('EVM_RPC_URL');
    if (!rpcUrl) {
      throw new Error('EVM_RPC_URL is not configured.');
    }
    this.chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '46630');

    // Optional backup RPCs (comma-separated). viem retries a failed request (e.g. a 429
    // from the public RPC) on the next URL. Keep the primary first: it serves wide
    // getLogs ranges that a free-tier Alchemy key rejects (10-block cap).
    // Without an explicit list, default to Alchemy for the configured chain when a key exists.
    const explicitFallbacks = (this.configService.get<string>('EVM_RPC_FALLBACK_URLS') || '')
      .split(',')
      .map(u => u.trim())
      .filter(Boolean);
    const alchemyKey = this.configService.get<string>('ALCHEMY_API_KEY')?.trim();
    const alchemyHost = ALCHEMY_HOST_BY_CHAIN_ID[this.chainId];
    const defaultFallbacks = alchemyKey && alchemyHost ? [`https://${alchemyHost}.g.alchemy.com/v2/${alchemyKey}`] : [];
    const fallbackUrls = (explicitFallbacks.length ? explicitFallbacks : defaultFallbacks).filter(
      u => u.replace(/\/$/, '') !== rpcUrl.replace(/\/$/, '')
    );

    this.client = createPublicClient({
      transport: fallbackUrls.length ? fallback([http(rpcUrl), ...fallbackUrls.map(u => http(u))]) : http(rpcUrl),
    });
    if (fallbackUrls.length) {
      this.logger.log(`EVM RPC: primary + ${fallbackUrls.length} fallback transport(s)`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get publicClient(): any {
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // View calls
  // ---------------------------------------------------------------------------

  async getCycle(vault: Address, cycleId: bigint): Promise<OnchainCycleView> {
    return this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'getCycle',
      args: [cycleId],
    }) as Promise<OnchainCycleView>;
  }

  async getContribution(vault: Address, id: bigint): Promise<OnchainContributionView> {
    return this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'getContribution',
      args: [id],
    }) as Promise<OnchainContributionView>;
  }

  async isClaimed(vault: Address, cycleId: bigint, claimIndex: bigint): Promise<boolean> {
    return this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'isClaimed',
      args: [cycleId, claimIndex],
    }) as Promise<boolean>;
  }

  async currentCycleId(vault: Address): Promise<bigint> {
    return this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'currentCycleId',
    }) as Promise<bigint>;
  }

  async totalContributions(vault: Address): Promise<bigint> {
    return this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'totalContributions',
    }) as Promise<bigint>;
  }

  // ---------------------------------------------------------------------------
  // Convenience helpers used by prepare paths.
  // ---------------------------------------------------------------------------

  async isCycleLocked(vault: Address, cycleId: bigint): Promise<boolean> {
    const c = await this.getCycle(vault, cycleId);
    return c.status === EvmCycleStatus.Locked;
  }

  async isCycleCancelled(vault: Address, cycleId: bigint): Promise<boolean> {
    const c = await this.getCycle(vault, cycleId);
    return c.status === EvmCycleStatus.Cancelled;
  }

  async isContributionActive(vault: Address, id: bigint): Promise<boolean> {
    try {
      const c = await this.getContribution(vault, id);
      return c.status === EvmContributionStatus.Active;
    } catch (err) {
      this.logger.debug(`getContribution(${id}) reverted: ${(err as Error).message}`);
      return false;
    }
  }

  /** Protocol fee rate the vault applies to `feeType`, read from its ProtocolFeeConfig. */
  async protocolFeeBps(vault: Address, feeType: ProtocolFeeType): Promise<number> {
    const feeConfig = (await this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'protocolFeeConfig',
    })) as Address;
    const bps = await this.client.readContract({
      address: feeConfig,
      abi: PROTOCOL_FEE_CONFIG_ABI,
      functionName: 'feeBps',
      args: [feeType],
    });
    return Number(bps);
  }

  async getTransactionReceipt(hash: Hex) {
    return this.client.getTransactionReceipt({ hash });
  }
}
