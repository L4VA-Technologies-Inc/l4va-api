import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';
import { EvmAssetKindOnchain } from './vault.abi';

import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { EvmAssetPriceFeedEntity } from '@/database/evmAssetPriceFeed.entity';
import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType } from '@/types/vault.types';

// ---------------------------------------------------------------------------
// Minimal viem ABI slices for the pricing pipeline.
// ---------------------------------------------------------------------------
const ERC20_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;

const CHAINLINK_AGGREGATOR_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const WHOLE_UNIT_SCALE = 10n ** 18n;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContributionValueEntry {
  /** Total wei value of the contribution (amount * unitPriceNative / 10^tokenDecimals). */
  valueNative: bigint;
  /** Bigint stringified — wei per whole unit (see EvmContributionValuation.unit_price_native). */
  unitPriceNative: string;
  /** Free-form provider tag written to the snapshot's `price_source` per asset. */
  source: string;
}

export type ContributionValueMap = Map<string /* evm_contribution.id */, ContributionValueEntry>;

export interface PricingResult {
  contributionValues: ContributionValueMap;
  priceSource: Record<string, string>;
  rawPrices: Record<string, unknown>;
  normalizedPrices: Record<string, string>;
  priceTimestamp: Date;
}

export class StalePriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalePriceError';
  }
}

export class MissingPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingPriceError';
  }
}

export class UnsupportedPriceQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPriceQuoteError';
  }
}

/**
 * Lock-time pricing pipeline. Consumed by EvmAllocationService.computeSnapshot
 * to build a `ContributionValueMap` with bigint-only math.
 *
 * Resolution order per contribution:
 *   1. kind = Native → 1:1 (wei = wei).
 *   2. assets_whitelist.custom_price_native_wei for the vault + asset →
 *      per-collection admin override (works for ERC-20 AND NFTs).
 *   3. ERC-20 only: Chainlink feed via evm_asset_price_feeds registry.
 *      quote_asset must be 'native'; 'usd' is rejected until USD conversion
 *      is wired in.
 *   4. Anything else → MissingPriceError (never fall through with a default).
 *
 * Every unit price is `bigint` wei per whole unit. Value is computed as:
 *   ERC20: (amount * unitPriceWei) / 10^tokenDecimals
 *   NFT:   amount * unitPriceWei
 *   Native: amount
 *
 * Chainlink freshness: reject if `updatedAt < now - feed.max_age_seconds`.
 *
 * Returned data feeds directly into EvmAllocationService.computeSnapshot.
 */
@Injectable()
export class EvmLockTimePricingService {
  private readonly logger = new Logger(EvmLockTimePricingService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmContribution) private readonly contribsRepository: Repository<EvmContribution>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly whitelistRepository: Repository<AssetsWhitelistEntity>,
    @InjectRepository(EvmAssetPriceFeedEntity)
    private readonly feedsRepository: Repository<EvmAssetPriceFeedEntity>,
    private readonly contractReader: EvmContractReader
  ) {}

  /**
   * Price every ACTIVE (i.e. not refunded / not cancelled) confirmed
   * EvmContribution for the given (vault, cycle) at the current time.
   *
   * Throws:
   *  - BadRequestException if vault is missing / not EVM.
   *  - MissingPriceError if any non-Native contribution has no resolvable price.
   *  - StalePriceError if a Chainlink feed answer is older than max_age_seconds.
   *  - UnsupportedPriceQuoteError if a matching Chainlink feed has quote_asset='usd'
   *    (until USD conversion is wired in).
   */
  async resolvePricesForCycle(vaultId: string, cycleId: bigint): Promise<PricingResult> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new BadRequestException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.chain_id) {
      throw new BadRequestException(`Vault ${vaultId} has no chain_id`);
    }

    const contributions = await this.contribsRepository.find({
      where: {
        vault_id: vaultId,
        cycle_id: cycleId.toString(),
        status: EvmContributionRowStatus.active,
      },
      order: { on_chain_contribution_id: 'ASC' },
    });

    if (contributions.length === 0) {
      throw new BadRequestException(
        `Vault ${vaultId} cycle ${cycleId} has no active contributions — nothing to price`
      );
    }

    // Preload lookup tables once — vault-scoped whitelist + global feeds.
    const whitelist = await this.whitelistRepository.find({ where: { vault: { id: vaultId } } });
    const whitelistByAsset = new Map<string, AssetsWhitelistEntity>();
    for (const w of whitelist) whitelistByAsset.set(w.policy_id.toLowerCase(), w);

    // Distinct non-Native asset addresses.
    const distinctAssets = Array.from(
      new Set(
        contributions
          .filter(c => c.kind !== EvmAssetKindOnchain.Native)
          .map(c => c.asset.toLowerCase())
      )
    );

    const feeds = distinctAssets.length
      ? await this.feedsRepository
          .createQueryBuilder('feed')
          .where('feed.chain_id = :chainId', { chainId: vault.chain_id })
          .andWhere('LOWER(feed.token_address) IN (:...tokens)', { tokens: distinctAssets })
          .andWhere('feed.enabled = :enabled', { enabled: true })
          .getMany()
      : [];
    const feedByAsset = new Map<string, EvmAssetPriceFeedEntity>();
    for (const f of feeds) feedByAsset.set(f.token_address.toLowerCase(), f);

    // ERC20 decimals cache (avoid repeated RPC).
    const erc20DecimalsCache = new Map<string, number>();
    const contributionValues: ContributionValueMap = new Map();
    const priceSource: Record<string, string> = {};
    const rawPrices: Record<string, unknown> = {};
    const normalizedPrices: Record<string, string> = {};
    const priceTimestamp = new Date();

    for (const c of contributions) {
      const assetKey = c.asset.toLowerCase();

      // --- Native -----------------------------------------------------------
      if (c.kind === EvmAssetKindOnchain.Native) {
        contributionValues.set(c.id, {
          valueNative: BigInt(c.amount),
          unitPriceNative: '1',
          source: 'native',
        });
        priceSource[assetKey] = 'native';
        normalizedPrices[assetKey] = '1';
        continue;
      }

      // --- Try manual override (works for ERC-20 AND NFTs) ------------------
      const override = whitelistByAsset.get(assetKey);
      if (override?.custom_price_native_wei) {
        const unitPriceWei = BigInt(override.custom_price_native_wei);
        if (unitPriceWei <= 0n) {
          throw new MissingPriceError(
            `assets_whitelist.custom_price_native_wei for ${assetKey} is zero — must be > 0`
          );
        }
        const valueNative = await this.applyUnitPrice(c, unitPriceWei, erc20DecimalsCache, vault.chain_id);
        contributionValues.set(c.id, {
          valueNative,
          unitPriceNative: unitPriceWei.toString(),
          source: 'assets_whitelist.custom_price_native_wei',
        });
        priceSource[assetKey] = 'assets_whitelist.custom_price_native_wei';
        rawPrices[assetKey] = { customPriceNativeWei: unitPriceWei.toString() };
        normalizedPrices[assetKey] = unitPriceWei.toString();
        continue;
      }

      // --- NFTs REQUIRE a manual override -----------------------------------
      if (c.kind === EvmAssetKindOnchain.ERC721 || c.kind === EvmAssetKindOnchain.ERC1155) {
        throw new MissingPriceError(
          `NFT contribution ${c.id} (${EvmAssetKindOnchain[c.kind]} at ${assetKey}) has no ` +
            `assets_whitelist.custom_price_native_wei for vault ${vaultId}. NFT collections must have ` +
            `an explicit manual/grouped floor price at lock time.`
        );
      }

      // --- ERC-20 via Chainlink --------------------------------------------
      const feed = feedByAsset.get(assetKey);
      if (!feed) {
        throw new MissingPriceError(
          `ERC-20 ${assetKey} has neither a whitelist override nor an enabled Chainlink feed on chain ${vault.chain_id}`
        );
      }
      if (feed.quote_asset !== 'native') {
        throw new UnsupportedPriceQuoteError(
          `Chainlink feed for ${assetKey} has quote_asset='${feed.quote_asset}'. ` +
            `Only 'native' is supported at lock time in the current pricing pipeline.`
        );
      }
      const feedInfo = await this.readNativeChainlinkFeed(feed, priceTimestamp);
      const unitPriceWei = feedInfo.unitPriceWei;
      const valueNative = await this.applyUnitPrice(c, unitPriceWei, erc20DecimalsCache, vault.chain_id);

      contributionValues.set(c.id, {
        valueNative,
        unitPriceNative: unitPriceWei.toString(),
        source: `chainlink:${feed.chainlink_feed_address}`,
      });
      priceSource[assetKey] = `chainlink:${feed.chainlink_feed_address}`;
      rawPrices[assetKey] = {
        chainlinkAnswer: feedInfo.rawAnswer.toString(),
        chainlinkDecimals: feedInfo.feedDecimals,
        chainlinkUpdatedAt: feedInfo.updatedAt.toString(),
        chainlinkMaxAgeSeconds: feed.max_age_seconds,
      };
      normalizedPrices[assetKey] = unitPriceWei.toString();
    }

    return {
      contributionValues,
      priceSource,
      rawPrices,
      normalizedPrices,
      priceTimestamp,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * unitPriceWei is wei per whole token / per NFT.
   * ERC20: value = (amount * unitPriceWei) / 10^tokenDecimals
   * NFT:   value = amount * unitPriceWei
   */
  private async applyUnitPrice(
    c: EvmContribution,
    unitPriceWei: bigint,
    erc20DecimalsCache: Map<string, number>,
    chainId: number
  ): Promise<bigint> {
    const amount = BigInt(c.amount);
    if (amount === 0n) {
      throw new BadRequestException(`Contribution ${c.id} has zero amount`);
    }

    if (c.kind === EvmAssetKindOnchain.ERC20) {
      const decimals = await this.getErc20Decimals(c.asset.toLowerCase(), erc20DecimalsCache, chainId);
      const scale = 10n ** BigInt(decimals);
      // (amount * unitPriceWei) / 10^decimals
      return (amount * unitPriceWei) / scale;
    }

    if (c.kind === EvmAssetKindOnchain.ERC721 || c.kind === EvmAssetKindOnchain.ERC1155) {
      return amount * unitPriceWei;
    }

    throw new BadRequestException(`Unexpected kind ${c.kind} for applyUnitPrice`);
  }

  private async getErc20Decimals(
    tokenAddress: string,
    cache: Map<string, number>,
    _chainId: number
  ): Promise<number> {
    const cached = cache.get(tokenAddress);
    if (cached !== undefined) return cached;
    const decimals = (await this.contractReader.publicClient.readContract({
      address: tokenAddress as Address,
      abi: ERC20_ABI,
      functionName: 'decimals',
    })) as number;
    cache.set(tokenAddress, Number(decimals));
    return Number(decimals);
  }

  private async readNativeChainlinkFeed(
    feed: EvmAssetPriceFeedEntity,
    now: Date
  ): Promise<{ unitPriceWei: bigint; rawAnswer: bigint; feedDecimals: number; updatedAt: bigint }> {
    const feedAddress = feed.chainlink_feed_address as Address;

    // Round data.
    const roundData = (await this.contractReader.publicClient.readContract({
      address: feedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: 'latestRoundData',
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const [, answer, , updatedAt] = roundData;

    if (answer <= 0n) {
      throw new MissingPriceError(
        `Chainlink feed ${feedAddress} for ${feed.token_address} returned non-positive answer (${answer})`
      );
    }

    const nowSec = BigInt(Math.floor(now.getTime() / 1000));
    const maxAge = BigInt(feed.max_age_seconds);
    if (updatedAt + maxAge < nowSec) {
      throw new StalePriceError(
        `Chainlink feed ${feedAddress} for ${feed.token_address} is stale: updatedAt=${updatedAt}, ` +
          `now=${nowSec}, maxAge=${maxAge}s`
      );
    }

    const feedDecimals =
      feed.feed_decimals ??
      Number(
        await this.contractReader.publicClient.readContract({
          address: feedAddress,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: 'decimals',
        })
      );

    // Native-quoted feed: answer is "wei per whole token" scaled by 10^feedDecimals.
    // Convert to wei per whole token by dividing by 10^feedDecimals … but that
    // may truncate. Preserve precision by first scaling to 18 (we choose wei
    // per whole token as the storage unit) and dividing at the end.
    //
    // For a native-quoted feed the answer's UNIT is: whole native per whole
    // token, expressed as an int with `feedDecimals` decimals. To get wei per
    // whole token: unitPriceWei = answer * 10^18 / 10^feedDecimals.
    const unitPriceWei = (answer * WHOLE_UNIT_SCALE) / 10n ** BigInt(feedDecimals);
    if (unitPriceWei <= 0n) {
      throw new MissingPriceError(
        `Chainlink feed ${feedAddress} for ${feed.token_address} produced 0 wei/token after scaling`
      );
    }

    return { unitPriceWei, rawAnswer: answer, feedDecimals, updatedAt };
  }
}
