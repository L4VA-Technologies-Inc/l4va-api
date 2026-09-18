import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EvmChainConfig, loadEvmChains, toViemChain } from './evm-chains.config';

import { ChainType, isEvmChain } from '@/types/vault.types';

/**
 * The single place that answers "which EVM chain is this vault on, and how do we talk to it".
 * Services take a vault's `chain_type` or `chain_id` and get back RPC clients, the factory
 * address and the chain's gas rules, instead of one hardcoded Robinhood configuration.
 */
@Injectable()
export class EvmChainsService implements OnModuleInit {
  private readonly logger = new Logger(EvmChainsService.name);

  private readonly chains: EvmChainConfig[];
  private readonly byChainId = new Map<number, EvmChainConfig>();
  private readonly byChainType = new Map<ChainType, EvmChainConfig>();
  private readonly publicClients = new Map<number, PublicClient>();
  private readonly walletClients = new Map<number, WalletClient>();

  constructor(private readonly configService: ConfigService) {
    this.chains = loadEvmChains(configService);
    for (const chain of this.chains) {
      this.byChainId.set(chain.chainId, chain);
      this.byChainType.set(chain.chainType, chain);
    }
  }

  onModuleInit(): void {
    if (this.chains.length === 0) {
      this.logger.warn('No EVM chain configured (set EVM_RPC_URL for Robinhood and/or ARC_RPC_URL for Arc).');
      return;
    }
    this.logger.log(
      `EVM chains: ${this.chains.map(c => `${c.chainType}(${c.chainId})${c.factoryAddress ? '' : ' [no factory]'}`).join(', ')}`
    );
  }

  get all(): EvmChainConfig[] {
    return this.chains;
  }

  /** The chain used when a caller has no vault context — the first configured one. */
  get defaultChain(): EvmChainConfig | undefined {
    return this.chains[0];
  }

  find(ref: ChainType | number | string | null | undefined): EvmChainConfig | undefined {
    if (ref === null || ref === undefined) return undefined;
    if (typeof ref === 'number') return this.byChainId.get(ref);
    const asNumber = Number(ref);
    if (Number.isFinite(asNumber) && asNumber > 0) return this.byChainId.get(asNumber);
    return isEvmChain(ref) ? this.byChainType.get(ref as ChainType) : undefined;
  }

  /** Same as `find`, but throws with a clear message — use on write paths. */
  get(ref: ChainType | number | string | null | undefined): EvmChainConfig {
    const chain = this.find(ref);
    if (!chain) {
      throw new Error(
        `EVM chain "${String(ref)}" is not configured. Configured: ${this.chains.map(c => c.chainType).join(', ') || 'none'}`
      );
    }
    return chain;
  }

  /** Resolves a vault's chain, preferring its chain_id and falling back to chain_type. */
  forVault(vault: { chain_id?: number | null; chain_type?: ChainType | string | null }): EvmChainConfig {
    return this.get(vault.chain_id ?? vault.chain_type);
  }

  publicClient(ref: ChainType | number | string): PublicClient {
    const chain = this.get(ref);
    const cached = this.publicClients.get(chain.chainId);
    if (cached) return cached;

    const client = createPublicClient({
      chain: toViemChain(chain),
      transport: this.transportFor(chain),
    }) as PublicClient;
    this.publicClients.set(chain.chainId, client);
    return client;
  }

  /** Primary RPC with the chain's backups behind it, so one provider blip is not fatal. */
  private transportFor(chain: EvmChainConfig) {
    const urls = [chain.rpcUrl, ...(chain.fallbackRpcUrls ?? [])];
    return urls.length > 1 ? fallback(urls.map(url => http(url))) : http(chain.rpcUrl);
  }

  adminAccount(ref: ChainType | number | string): Account {
    const chain = this.get(ref);
    if (!chain.adminPrivateKey) {
      throw new Error(
        `No admin private key configured for ${chain.chainType} (${chain.chainType.toUpperCase()}_ADMIN_PRIVATE_KEY).`
      );
    }
    return privateKeyToAccount(chain.adminPrivateKey);
  }

  walletClient(ref: ChainType | number | string): WalletClient {
    const chain = this.get(ref);
    const cached = this.walletClients.get(chain.chainId);
    if (cached) return cached;

    const client = createWalletClient({
      account: this.adminAccount(chain.chainId),
      chain: toViemChain(chain),
      transport: this.transportFor(chain),
    });
    this.walletClients.set(chain.chainId, client);
    return client;
  }

  /**
   * Clamps a gas limit to what the chain accepts. Arc rejects anything above 2^24
   * outright, so a padded estimate must be capped before it is broadcast.
   */
  clampGas(ref: ChainType | number | string, gas: bigint): bigint {
    const max = this.find(ref)?.maxTxGas;
    return max && gas > max ? max : gas;
  }

  /** Raises maxFeePerGas to the chain's floor (Arc drops anything below 20 gwei). */
  floorMaxFeePerGas(ref: ChainType | number | string, maxFeePerGas: bigint): bigint {
    const floor = this.find(ref)?.minMaxFeePerGasWei;
    return floor && maxFeePerGas < floor ? floor : maxFeePerGas;
  }
}
