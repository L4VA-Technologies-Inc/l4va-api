import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Lucid, type TxSignBuilder, type UTxO } from '@lucid-evolution/lucid';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  MINSWAP_V2,
  MINSWAP_V2_CONFIG,
  MINSWAP_V2_DEPLOYED_SCRIPTS,
  type MinswapV2Config,
} from './minswap-v2.constants';
import {
  ADA_ASSET,
  AUTHEN_MINT_CREATE_POOL_REDEEMER,
  assetFromUnit,
  assetToUnit,
  calculateInitialLiquidity,
  compareAssets,
  computeLpAssetName,
  decodeFactoryDatum,
  encodeFactoryDatum,
  encodeFactoryRedeemer,
  encodePoolDatum,
  stakeScriptHash,
  type MinswapAsset,
} from './minswap-v2.utils';

import { createLucidBlockfrostProvider, lucidNetworkFromCardanoEnv } from '@/common/cardano/blockfrost-lucid';
import { formatCip674MetadataMessage } from '@/common/cardano/cip674-metadata';
import { Claim } from '@/database/claim.entity';
import type { LpClaimMetadata } from '@/types/claim-metadata.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';

type FactoryUtxoRef = { txHash: string; outputIndex: number; head: string; tail: string };

/**
 * Creates vault-token/ADA liquidity pools on Minswap DEX V2.
 *
 * Unlike VyFi (send funds to a factory address and wait for an off-chain operator),
 * a Minswap V2 pool is created directly by our transaction: it spends the factory
 * UTxO, creates the pool UTxO and mints the LP tokens, which land in the admin
 * wallet (change output) in the same transaction.
 */
@Injectable()
export class MinswapService {
  private readonly logger = new Logger(MinswapService.name);
  private readonly isMainnet: boolean;
  private readonly config: MinswapV2Config;
  private readonly blockfrostProjectId: string;
  private readonly blockfrost: BlockFrostAPI;
  private readonly adminAddress: string;
  private readonly adminSKey: string;
  /** Trading fee numerator with denominator 10000 (30 = 0.3%). */
  private readonly tradingFeeNumerator: bigint;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.config = MINSWAP_V2_CONFIG[this.isMainnet ? 'mainnet' : 'testnet'];
    this.blockfrostProjectId = this.configService.get<string>('BLOCKFROST_API_KEY');
    this.blockfrost = new BlockFrostAPI({ projectId: this.blockfrostProjectId });
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');

    const feeRaw = this.configService.get<string>('MINSWAP_POOL_TRADING_FEE_BPS') ?? '30';
    const fee = BigInt(Number.parseInt(feeRaw, 10) || 0);
    if (fee < MINSWAP_V2.MIN_TRADING_FEE || fee > MINSWAP_V2.MAX_TRADING_FEE) {
      throw new Error(
        `Invalid MINSWAP_POOL_TRADING_FEE_BPS: expected ${MINSWAP_V2.MIN_TRADING_FEE}..${MINSWAP_V2.MAX_TRADING_FEE} (basis points), got "${feeRaw}"`
      );
    }
    this.tradingFeeNumerator = fee;
  }

  /** Full LP token unit (policy + asset name) of the Minswap V2 pool for a token/ADA pair. */
  getLpTokenUnit(tokenUnit: string): string {
    return this.config.lpPolicyId + computeLpAssetName(ADA_ASSET, assetFromUnit(tokenUnit));
  }

  /** A pool exists iff its LP token has been minted. */
  async poolExists(tokenUnit: string): Promise<boolean> {
    try {
      await this.blockfrost.assetsById(this.getLpTokenUnit(tokenUnit));
      return true;
    } catch (error) {
      if (error?.status_code === 404) return false;
      throw error;
    }
  }

  /**
   * Finds the factory UTxO whose (head, tail) interval contains the new pool's LP asset name.
   * Factory UTxOs form a sorted linked list of existing pools; creating a pool splits one link in two.
   */
  private async findFactoryForLpAssetName(lpAssetName: string): Promise<FactoryUtxoRef | null> {
    const utxos = await this.blockfrost.addressesUtxosAssetAll(
      this.config.factoryScriptHashBech32,
      this.config.factoryAsset
    );

    for (const utxo of utxos) {
      if (!utxo.inline_datum) continue;
      try {
        const { head, tail } = decodeFactoryDatum(utxo.inline_datum);
        if (head < lpAssetName && lpAssetName < tail) {
          return { txHash: utxo.tx_hash, outputIndex: utxo.output_index, head, tail };
        }
      } catch {
        this.logger.warn(`Skipping undecodable Minswap factory UTxO ${utxo.tx_hash}#${utxo.output_index}`);
      }
    }
    return null;
  }

  /**
   * Creates the VT/ADA pool for a vault from its AVAILABLE LP claim, using admin wallet UTxOs.
   * ADA reserve = claim.lovelace_amount, VT reserve = claim.amount.
   * The admin wallet additionally covers the 4.5 ADA locked in the pool UTxO and tx fees.
   */
  async createLiquidityPool(vaultId: string): Promise<{ txHash: string; lpTokenUnit: string; lpTokens: string }> {
    const claim = await this.claimRepository.findOne({
      where: { vault: { id: vaultId }, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
      relations: ['vault'],
    });
    if (!claim) {
      throw new NotFoundException('Liquidity pool claim not found');
    }

    const vtUnit = `${claim.vault.script_hash}${claim.vault.asset_vault_name}`.toLowerCase();
    const { tx, lpTokenUnit, lpTokens } = await this.buildCreatePoolTx({
      tokenUnit: vtUnit,
      adaReserve: BigInt(claim.lovelace_amount || 0),
      tokenReserve: BigInt(claim.amount || 0),
    });

    const signedTx = await tx.sign.withPrivateKey(this.adminSKey).complete();
    const txHash = await signedTx.submit();

    this.logger.log(`Minswap V2 pool creation submitted for vault ${vaultId}: ${txHash}`);

    const metadata: LpClaimMetadata = {
      ...((claim.metadata as LpClaimMetadata) ?? {}),
      dex: 'minswap',
      poolTxHash: txHash,
      lpTokenUnit,
      lpTokens: lpTokens.toString(),
    };
    await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED, metadata });

    return { txHash, lpTokenUnit, lpTokens: lpTokens.toString() };
  }

  /**
   * Builds (and evaluates scripts of) an unsigned token/ADA pool creation tx paid from the admin wallet.
   * Does not sign or submit.
   */
  async buildCreatePoolTx({
    tokenUnit,
    adaReserve,
    tokenReserve,
  }: {
    tokenUnit: string;
    adaReserve: bigint;
    tokenReserve: bigint;
  }): Promise<{ tx: TxSignBuilder; lpTokenUnit: string; lpTokens: bigint }> {
    if (adaReserve <= 0n || tokenReserve <= 0n) {
      throw new Error(`Invalid pool reserves: ADA=${adaReserve}, token=${tokenReserve}`);
    }

    const tokenAsset = assetFromUnit(tokenUnit.toLowerCase());
    const [assetA, assetB, reserveA, reserveB]: [MinswapAsset, MinswapAsset, bigint, bigint] =
      compareAssets(ADA_ASSET, tokenAsset) < 0
        ? [ADA_ASSET, tokenAsset, adaReserve, tokenReserve]
        : [tokenAsset, ADA_ASSET, tokenReserve, adaReserve];

    const lpAssetName = computeLpAssetName(assetA, assetB);
    const lpTokenUnit = this.config.lpPolicyId + lpAssetName;

    if (await this.poolExists(tokenUnit)) {
      throw new Error(`Minswap pool already exists for ${tokenUnit} (LP ${lpTokenUnit})`);
    }

    const factory = await this.findFactoryForLpAssetName(lpAssetName);
    if (!factory) {
      throw new Error(`No Minswap V2 factory UTxO found for LP ${lpAssetName}; the pool may already exist`);
    }

    const initialLiquidity = calculateInitialLiquidity(reserveA, reserveB);
    const lpTokens = initialLiquidity - MINSWAP_V2.MINIMUM_LIQUIDITY;
    if (lpTokens <= 0n) {
      throw new Error(`Initial liquidity too small: ADA=${adaReserve}, token=${tokenReserve}`);
    }

    const poolDatum = encodePoolDatum({
      poolBatchingStakeScriptHash: stakeScriptHash(this.config.poolBatchingAddress),
      assetA,
      assetB,
      totalLiquidity: initialLiquidity,
      reserveA,
      reserveB,
      tradingFeeNumerator: this.tradingFeeNumerator,
    });

    const poolValue: Record<string, bigint> = {
      lovelace: MINSWAP_V2.DEFAULT_POOL_ADA,
      [lpTokenUnit]: MINSWAP_V2.MAX_LIQUIDITY - lpTokens,
      [this.config.poolAuthenAsset]: 1n,
    };
    for (const [asset, amount] of [
      [assetA, reserveA],
      [assetB, reserveB],
    ] as const) {
      const unit = assetToUnit(asset);
      poolValue[unit] = (poolValue[unit] ?? 0n) + amount;
    }

    const network = lucidNetworkFromCardanoEnv(this.isMainnet);
    const lucid = await Lucid(createLucidBlockfrostProvider(this.blockfrostProjectId, network), network);
    lucid.selectWallet.fromAddress(this.adminAddress, await lucid.utxosAt(this.adminAddress));

    const deployed = MINSWAP_V2_DEPLOYED_SCRIPTS[this.isMainnet ? 'mainnet' : 'testnet'];
    const [factoryRef, authenRef, factoryUtxo] = await Promise.all([
      this.getSingleUtxo(lucid, deployed.factory, 'Minswap factory validator reference script'),
      this.getSingleUtxo(lucid, deployed.authen, 'Minswap authen policy reference script'),
      this.getSingleUtxo(lucid, factory, 'Minswap factory UTxO'),
    ]);

    this.logger.log(
      `Building Minswap V2 pool: ADA=${adaReserve} token=${tokenReserve} ` +
        `fee=${this.tradingFeeNumerator}bps LP=${lpTokenUnit} lpToAdmin=${lpTokens}`
    );

    const tx = await lucid
      .newTx()
      .readFrom([factoryRef, authenRef])
      .collectFrom([factoryUtxo], encodeFactoryRedeemer(assetA, assetB))
      .pay.ToContract(this.config.poolCreationAddress, { kind: 'inline', value: poolDatum }, poolValue)
      .pay.ToContract(
        this.config.factoryAddress,
        { kind: 'inline', value: encodeFactoryDatum(factory.head, lpAssetName) },
        { [this.config.factoryAsset]: 1n }
      )
      .pay.ToContract(
        this.config.factoryAddress,
        { kind: 'inline', value: encodeFactoryDatum(lpAssetName, factory.tail) },
        { [this.config.factoryAsset]: 1n }
      )
      .mintAssets(
        {
          [lpTokenUnit]: MINSWAP_V2.MAX_LIQUIDITY,
          [this.config.factoryAsset]: 1n,
          [this.config.poolAuthenAsset]: 1n,
        },
        AUTHEN_MINT_CREATE_POOL_REDEEMER
      )
      .attachMetadata(674, formatCip674MetadataMessage(MINSWAP_V2.CREATE_POOL_METADATA))
      .complete({ changeAddress: this.adminAddress });

    return { tx, lpTokenUnit, lpTokens };
  }

  private async getSingleUtxo(
    lucid: Awaited<ReturnType<typeof Lucid>>,
    ref: { txHash: string; outputIndex: number },
    label: string
  ): Promise<UTxO> {
    const [utxo] = await lucid.utxosByOutRef([{ txHash: ref.txHash, outputIndex: ref.outputIndex }]);
    if (!utxo) throw new Error(`Cannot find ${label} at ${ref.txHash}#${ref.outputIndex}`);
    return utxo;
  }
}
