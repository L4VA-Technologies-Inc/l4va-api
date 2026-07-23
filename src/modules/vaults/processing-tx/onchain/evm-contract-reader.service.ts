import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, type Address, type Hex } from 'viem';

import { EvmContributionStatus, EvmCycleStatus, VAULT_ABI } from './vault.abi';

/** Shape returned by Vault.getCycle(cycleId). Mirrors CycleView in Vault.sol. */
export interface OnchainCycleView {
  cycleId: bigint;
  status: number;
  assetWindow: { start: bigint; end: bigint };
  acquireWindow: { start: bigint; end: bigint };
  minAcquireThreshold: bigint;
  adaPairVtPerNativeUnit: bigint;
  allocationRoot: Hex;
  valuationHash: Hex;
  totalVtAllocation: bigint;
  claimedVt: bigint;
  totalNativeAllocation: bigint;
  claimedNative: bigint;
  nativeCollected: bigint;
}

/** Shape returned by Vault.getContribution(id). Mirrors Contribution in Vault.sol. */
export interface OnchainContributionView {
  id: bigint;
  cycleId: bigint;
  contributor: Address;
  kind: number;
  asset: Address;
  tokenId: bigint;
  amount: bigint;
  status: number;
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

    this.client = createPublicClient({
      transport: http(rpcUrl),
    });
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

  async getTransactionReceipt(hash: Hex) {
    return this.client.getTransactionReceipt({ hash });
  }
}
