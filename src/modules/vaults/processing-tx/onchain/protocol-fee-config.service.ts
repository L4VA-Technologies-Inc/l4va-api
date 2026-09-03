import { Injectable, Logger } from '@nestjs/common';
import type { Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';

/** Mirrors `FeeType` in `src/interfaces/IProtocolFeeConfig.sol`. */
export enum FeeType {
  Contribution = 0,
  Distribution = 1,
  Trade = 2,
}

const VAULT_FEE_CONFIG_ABI = [
  {
    type: 'function',
    name: 'protocolFeeConfig',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const PROTOCOL_FEE_CONFIG_ABI = [
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [{ name: 'feeType', type: 'uint8' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'feeRecipient',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

interface CacheEntry {
  bps: number;
  readAt: number;
}

/**
 * Reads the live protocol fee schedule from the on-chain `ProtocolFeeConfig`
 * that a vault points at.
 *
 * Deliberately NOT mirrored into an env var. The vault charges whatever the
 * config says at execution time; a stale env copy would make the backend
 * compute `minExpectedOutput` against a rate the contract no longer uses, and
 * governance swaps would revert with `PositionMinOutputNotMet`.
 *
 * Values are cached briefly — the rate only changes on a governance action, and
 * a swap quote is already only valid for seconds.
 */
@Injectable()
export class ProtocolFeeConfigService {
  private readonly logger = new Logger(ProtocolFeeConfigService.name);
  private static readonly TTL_MS = 60_000;

  private readonly configAddressByVault = new Map<string, Address>();
  private readonly bpsCache = new Map<string, CacheEntry>();

  constructor(private readonly contractReader: EvmContractReader) {}

  /** Address of the `ProtocolFeeConfig` the given vault reads from. */
  async configAddressFor(vault: Address): Promise<Address> {
    const key = vault.toLowerCase();
    const cached = this.configAddressByVault.get(key);
    if (cached) return cached;

    // Immutable on the vault, so it is safe to cache for the process lifetime.
    const address = (await this.contractReader.publicClient.readContract({
      address: vault,
      abi: VAULT_FEE_CONFIG_ABI,
      functionName: 'protocolFeeConfig',
    })) as Address;

    this.configAddressByVault.set(key, address);
    return address;
  }

  /**
   * Current fee rate in basis points for `feeType` as the given vault will
   * apply it. Returns 0 if the read fails, matching the contract's behaviour
   * when the rate is unset — a zero here only ever makes `minExpectedOutput`
   * stricter, never looser than the vault's own check.
   */
  async feeBps(vault: Address, feeType: FeeType): Promise<number> {
    const cacheKey = `${vault.toLowerCase()}:${feeType}`;
    const hit = this.bpsCache.get(cacheKey);
    if (hit && Date.now() - hit.readAt < ProtocolFeeConfigService.TTL_MS) {
      return hit.bps;
    }

    try {
      const configAddress = await this.configAddressFor(vault);
      const bps = Number(
        await this.contractReader.publicClient.readContract({
          address: configAddress,
          abi: PROTOCOL_FEE_CONFIG_ABI,
          functionName: 'feeBps',
          args: [feeType],
        })
      );
      this.bpsCache.set(cacheKey, { bps, readAt: Date.now() });
      return bps;
    } catch (err) {
      this.logger.warn(
        `Failed to read feeBps(${FeeType[feeType]}) for vault ${vault}: ${(err as Error).message}. Assuming 0.`
      );
      return 0;
    }
  }

  /** Convenience: the L4VA trade fee applied to governance swaps. */
  async tradeFeeBps(vault: Address): Promise<number> {
    return this.feeBps(vault, FeeType.Trade);
  }

  async feeRecipient(vault: Address): Promise<Address | null> {
    try {
      const configAddress = await this.configAddressFor(vault);
      return (await this.contractReader.publicClient.readContract({
        address: configAddress,
        abi: PROTOCOL_FEE_CONFIG_ABI,
        functionName: 'feeRecipient',
      })) as Address;
    } catch (err) {
      this.logger.warn(`Failed to read feeRecipient for vault ${vault}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Applies the trade fee to a gross amount, returning what the vault will
   * actually retain. Mirrors `Vault._calculateFee` exactly, including its
   * floor division, so the backend and the contract never disagree by a wei.
   */
  static applyFee(grossAmount: bigint, bps: number): bigint {
    if (bps <= 0) return grossAmount;
    const fee = (grossAmount * BigInt(bps)) / 10_000n;
    return grossAmount - fee;
  }
}
