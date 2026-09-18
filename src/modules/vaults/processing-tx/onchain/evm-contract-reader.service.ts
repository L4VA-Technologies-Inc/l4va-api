import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmContributionStatus, EvmCycleStatus, VAULT_ABI } from './vault.abi';

import { Vault } from '@/database/vault.entity';
import { EvmChainsService } from '@/modules/evm-chains/evm-chains.service';

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
  /** Vault address (lowercase) -> chain id. Vault addresses never move between chains. */
  private readonly chainIdByVault = new Map<string, number>();

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly evmChains: EvmChainsService
  ) {}

  /** Chain id of the default (first configured) chain — used when there is no vault context. */
  get chainId(): number {
    return this.evmChains.defaultChain?.chainId ?? 0;
  }

  /**
   * Which chain a vault contract lives on. Prefer an explicit chain_id from the
   * caller — addresses are only unique within a chain, so an address-only
   * lookup must not pick among Robinhood vs Arc collisions.
   */
  async chainIdOf(address: Address, chainIdHint?: number): Promise<number> {
    if (chainIdHint) return chainIdHint;

    const key = address.toLowerCase();
    const cached = this.chainIdByVault.get(key);
    if (cached) return cached;

    const rows = await this.vaultRepository
      .createQueryBuilder('v')
      .where('LOWER(v.contract_address) = :addr', { addr: key })
      .select(['v.id', 'v.chain_id'])
      .getMany();
    const chainIds = [
      ...new Set(
        rows
          .map(row => (row.chain_id != null ? Number(row.chain_id) : undefined))
          .filter((id): id is number => Number.isFinite(id))
      ),
    ];
    if (chainIds.length > 1) {
      throw new Error(`Contract ${key} is registered on multiple chains (${chainIds.join(', ')}); pass chain_id`);
    }
    if (chainIds.length === 1) {
      this.chainIdByVault.set(key, chainIds[0]);
      return chainIds[0];
    }

    // Not a vault address: a vault token, adapter or plain ERC-20. Ask each configured
    // chain which one actually has code there — defaulting made reads return "0x", e.g.
    // an Arc vault token read against Robinhood during the termination preflight.
    const unique = await this.findChainWithCode(address);
    if (unique) {
      this.chainIdByVault.set(key, unique);
      return unique;
    }
    return this.chainId;
  }

  private async findChainWithCode(address: Address): Promise<number | undefined> {
    const found: number[] = [];
    for (const chain of this.evmChains.all) {
      try {
        const code = await this.evmChains.publicClient(chain.chainId).getCode({ address });
        if (code && code !== '0x') found.push(chain.chainId);
      } catch (error) {
        this.logger.debug(`getCode(${address}) failed on ${chain.chainType}: ${(error as Error).message}`);
      }
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(`${address} has code on chains ${found.join(', ')}; pass chain_id rather than guessing`);
    }
    return undefined;
  }

  /**
   * Client for the chain an address lives on.
   * @param chainIdHint the vault's chain when the caller knows it — authoritative, skips the lookup.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async clientFor(address: Address, chainIdHint?: number): Promise<any> {
    return this.evmChains.publicClient(await this.chainIdOf(address, chainIdHint));
  }

  /** Default-chain client for callers without a vault address (webhooks, receipts). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get publicClient(): any {
    return this.evmChains.publicClient(this.chainId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClientFor(chainId: number): any {
    return this.evmChains.publicClient(chainId);
  }

  // ---------------------------------------------------------------------------
  // View calls
  // ---------------------------------------------------------------------------

  async getCycle(vault: Address, cycleId: bigint): Promise<OnchainCycleView> {
    return (await this.clientFor(vault)).readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'getCycle',
      args: [cycleId],
    }) as Promise<OnchainCycleView>;
  }

  async getContribution(vault: Address, id: bigint): Promise<OnchainContributionView> {
    return (await this.clientFor(vault)).readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'getContribution',
      args: [id],
    }) as Promise<OnchainContributionView>;
  }

  async isClaimed(vault: Address, cycleId: bigint, claimIndex: bigint): Promise<boolean> {
    return (await this.clientFor(vault)).readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'isClaimed',
      args: [cycleId, claimIndex],
    }) as Promise<boolean>;
  }

  async currentCycleId(vault: Address): Promise<bigint> {
    return (await this.clientFor(vault)).readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'currentCycleId',
    }) as Promise<bigint>;
  }

  async totalContributions(vault: Address): Promise<bigint> {
    return (await this.clientFor(vault)).readContract({
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

  async getTransactionReceipt(hash: Hex, chainId?: number) {
    return this.evmChains.publicClient(chainId ?? this.chainId).getTransactionReceipt({ hash });
  }
}
