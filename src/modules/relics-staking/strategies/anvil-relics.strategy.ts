import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AnvilApiClient, AnvilStakeAsset } from '../clients/anvil-api.client';

import {
  IStakingPlatformStrategy,
  StakeExecutionResult,
  StakingExecutionContext,
  UnstakeExecutionResult,
} from './staking-platform.interface';

import { Asset } from '@/database/asset.entity';
import { VaultStakingPosition, VaultStakingPositionStatus } from '@/database/vault-staking-position.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { AssetStatus } from '@/types/asset.types';

const RELICS_VITA_POLICY = '94ec588251e710b7660dfd7765f08c87742a3012cce802897a3ebd28';
const RELICS_PORTA_POLICY = '14296258677a869366d6bb01568f31f7b2e690208739b7bcdca444b2';
const VLRM_UNIT = '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c056616c6f72756d';
const STAKE_COLLECTION_ID = 54;
const MAX_NFTS_PER_BATCH = 50;

/**
 * Anvil Relics Staking Platform Strategy.
 *
 * Handles the full stake / unstake execution flow:
 *   build (Anvil) → sign (treasury keys) → submit (Anvil or chain)
 *
 * Only runs real transactions on mainnet.  On testnet the caller is expected
 * to gate execution before calling these methods.
 */
@Injectable()
export class AnvilRelicsStakingStrategy implements IStakingPlatformStrategy {
  private readonly logger = new Logger(AnvilRelicsStakingStrategy.name);
  private readonly blockfrost: BlockFrostAPI;

  readonly platform = 'anvil-relics';
  readonly eligiblePolicies = [RELICS_VITA_POLICY, RELICS_PORTA_POLICY];
  readonly rewardToken = { unit: VLRM_UNIT, decimals: 4 };
  readonly stakeCollectionId = STAKE_COLLECTION_ID;

  constructor(
    private readonly anvilApiClient: AnvilApiClient,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(VaultStakingPosition)
    private readonly positionRepository: Repository<VaultStakingPosition>
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  // ---------------------------------------------------------------------------
  // IStakingPlatformStrategy
  // ---------------------------------------------------------------------------

  async executeStake(assets: Asset[], ctx: StakingExecutionContext): Promise<StakeExecutionResult[]> {
    this.logger.log(`executeStake: ${assets.length} assets for vault ${ctx.vaultId}`);

    const invalidAssets = assets.filter(a => !this.eligiblePolicies.includes(a.policy_id));
    if (invalidAssets.length > 0) {
      throw new Error(`Assets not eligible for Anvil staking: ${invalidAssets.map(a => a.id).join(', ')}`);
    }

    const { changeAddress, utxos } = await this.getTreasuryContext(ctx.treasuryAddress);
    const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(ctx.vaultId);

    const batches = this.chunk(assets, MAX_NFTS_PER_BATCH);
    const results: StakeExecutionResult[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      this.logger.log(`Staking batch ${i + 1}/${batches.length} (${batch.length} NFTs)`);

      // Idempotency: skip batch if all assets in it are already staked with a tx hash
      const alreadyDone = batch.filter(
        a => a.status === AssetStatus.STAKED && a.staking_platform === this.platform && a.stake_tx_hash
      );
      if (alreadyDone.length === batch.length) {
        this.logger.warn(`Batch ${i + 1} already fully staked, skipping`);
        continue;
      }

      // Build the unsigned transaction
      const anvilAssets: AnvilStakeAsset[] = batch.map(a => ({
        unit: `${a.policy_id}${a.asset_id}`,
        quantity: 1,
      }));

      const buildResp = await this.anvilApiClient.stakeAssetsV2({
        stakeCollectionId: STAKE_COLLECTION_ID,
        assets: anvilAssets,
        changeAddress,
        utxos,
      });

      this.logger.log(`Batch ${i + 1}: Anvil built tx, stakeId=${buildResp.stakeId}`);

      // Sign the transaction with treasury wallet keys
      const txToSign = FixedTransaction.from_bytes(Buffer.from(buildResp.transaction, 'hex'));
      txToSign.sign_and_add_vkey_signature(privateKey);
      txToSign.sign_and_add_vkey_signature(stakePrivateKey);
      const witnessSetHex = Buffer.from(txToSign.witness_set().to_bytes()).toString('hex');

      // Submit via Anvil (tracks the stakeId server-side)
      // changeAddress + stakeCollectionId are passed so submitStakeV2 can
      // invalidate the getStakesV2 Redis cache automatically.
      const submitResp = await this.anvilApiClient.submitStakeV2({
        transaction: buildResp.transaction,
        stakeId: buildResp.stakeId,
        signature: witnessSetHex,
        context: 'STAKING',
        changeAddress,
        stakeCollectionId: STAKE_COLLECTION_ID,
      });

      this.logger.log(`Batch ${i + 1}: submitted, txHash=${submitResp.txHash}`);

      // Persist staking position
      const position = this.positionRepository.create({
        vault_id: ctx.vaultId,
        platform: this.platform,
        stake_collection_id: STAKE_COLLECTION_ID,
        stake_id: String(buildResp.stakeId),
        status: VaultStakingPositionStatus.STAKED,
        stake_tx_hash: submitResp.txHash,
        asset_ids: batch.map(a => a.id),
        started_at: new Date(),
        raw_stake_response: { stakeId: buildResp.stakeId, txHash: submitResp.txHash },
      });
      await this.positionRepository.save(position);

      // Update assets in DB (only after real txHash is available)
      await this.assetRepository.update(
        { id: In(batch.map(a => a.id)) },
        {
          status: AssetStatus.STAKED,
          staking_platform: this.platform,
          stake_id: String(buildResp.stakeId),
          stake_collection_id: STAKE_COLLECTION_ID,
          stake_tx_hash: submitResp.txHash,
          staked_at: new Date(),
        }
      );

      results.push({
        batchIndex: i,
        stakeId: buildResp.stakeId,
        txHash: submitResp.txHash,
        assetIds: batch.map(a => a.id),
      });
    }

    return results;
  }

  async executeUnstake(
    stakeIds: number[],
    ctx: StakingExecutionContext,
    claim: boolean
  ): Promise<UnstakeExecutionResult[]> {
    this.logger.log(`executeUnstake: stakeIds=[${stakeIds.join(',')}], claim=${claim}, vault=${ctx.vaultId}`);

    const { changeAddress, utxos } = await this.getTreasuryContext(ctx.treasuryAddress);
    const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(ctx.vaultId);

    const results: UnstakeExecutionResult[] = [];

    for (const stakeId of stakeIds) {
      this.logger.log(`Harvesting stakeId=${stakeId}, claim=${claim}`);

      const buildResp = await this.anvilApiClient.harvestStakeV2({
        stakeId,
        changeAddress,
        utxos,
        claim,
      });

      this.logger.log(`harvestStakeV2 built tx for stakeId=${stakeId}`);

      // Sign the transaction with treasury keys
      const txToSign = FixedTransaction.from_bytes(Buffer.from(buildResp.transaction, 'hex'));
      txToSign.sign_and_add_vkey_signature(privateKey);
      txToSign.sign_and_add_vkey_signature(stakePrivateKey);
      const signedTxHex = Buffer.from(txToSign.to_bytes()).toString('hex');

      // Submit directly to the blockchain
      // (harvest transactions only need the staker's signature; Anvil tracks the change via its indexer)
      const submitResp = await this.blockchainService.submitTransaction({
        transaction: signedTxHex,
        signatures: [],
      });

      this.logger.log(`Unstake submitted: stakeId=${stakeId}, txHash=${submitResp.txHash}`);

      // Parse VLRM rewards from transaction outputs (both unstake and harvest operations claim rewards)
      let claimedVlrmRaw: string | undefined;
      try {
        const tx = FixedTransaction.from_bytes(Buffer.from(buildResp.transaction, 'hex'));
        const txBody = tx.body();
        const outputs = txBody.outputs();

        // Find VLRM tokens in outputs going to treasury address
        for (let i = 0; i < outputs.len(); i++) {
          const output = outputs.get(i);
          const outputAddr = output.address().to_bech32();

          // Check if output goes to treasury
          if (outputAddr === ctx.treasuryAddress) {
            const multiAsset = output.amount()?.multiasset();
            if (!multiAsset) continue;

            // Look for VLRM token (policyId + assetName)
            const vlrmPolicyId = VLRM_UNIT.slice(0, 56);
            const vlrmAssetName = VLRM_UNIT.slice(56);
            const scriptHash = multiAsset.keys();

            for (let j = 0; j < scriptHash.len(); j++) {
              const policyId = scriptHash.get(j);
              const policyIdHex = Buffer.from(policyId.to_bytes()).toString('hex');

              if (policyIdHex === vlrmPolicyId) {
                const assets = multiAsset.get(policyId);
                if (!assets) continue;

                const assetNames = assets.keys();
                for (let k = 0; k < assetNames.len(); k++) {
                  const assetName = assetNames.get(k);
                  const assetNameHex = Buffer.from(assetName.name()).toString('hex');

                  if (assetNameHex === vlrmAssetName) {
                    const amount = assets.get(assetName);
                    if (amount) {
                      claimedVlrmRaw = amount.to_str();
                      this.logger.log(`Parsed VLRM reward: ${claimedVlrmRaw} (raw amount with 4 decimals)`);
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      } catch (parseError) {
        this.logger.error(
          `Failed to parse VLRM rewards from tx: ${parseError instanceof Error ? parseError.message : String(parseError)}`
        );
        // Continue without rewards - don't block execution
      }

      // Invalidate getStakesV2 Redis cache so the next read reflects the change
      await this.anvilApiClient.invalidateStakesCache(STAKE_COLLECTION_ID, changeAddress);

      // Update staking position record
      const positionUpdate: Partial<VaultStakingPosition> = {
        status: claim ? VaultStakingPositionStatus.UNSTAKED : VaultStakingPositionStatus.HARVESTING,
        unstake_tx_hash: submitResp.txHash,
        ended_at: claim ? new Date() : undefined,
        raw_harvest_response: { txHash: submitResp.txHash, claimedVlrmRaw } as any,
      };
      await this.positionRepository.update({ stake_id: String(stakeId), vault_id: ctx.vaultId }, positionUpdate);

      if (claim) {
        // Clear staking fields from assets; preserve historical unstake data
        await this.assetRepository.update(
          { stake_id: String(stakeId), vault_id: ctx.vaultId },
          {
            status: AssetStatus.EXTRACTED,
            staking_platform: undefined as any,
            stake_collection_id: undefined as any,
            // Keep stake_id for audit – only clear platform / collection
            unstake_tx_hash: submitResp.txHash,
            unstaked_at: new Date(),
          }
        );
      }

      results.push({ stakeId, txHash: submitResp.txHash, claimedVlrmRaw });
    }

    return results;
  }

  async getAnvilStakes(treasuryAddress: string): Promise<any[]> {
    try {
      const changeAddress = Buffer.from(Address.from_bech32(treasuryAddress).to_bytes()).toString('hex');
      const resp = await this.anvilApiClient.getStakesV2(STAKE_COLLECTION_ID, changeAddress);
      return resp.stakes ?? [];
    } catch (error: any) {
      this.logger.error(
        `getAnvilStakes failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined
      );
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts the bech32 treasury address to the hex format Anvil expects,
   * and fetches UTxOs in CBOR hex format.
   */
  private async getTreasuryContext(treasuryAddressBech32: string): Promise<{ changeAddress: string; utxos: string[] }> {
    const addr = Address.from_bech32(treasuryAddressBech32);
    // Anvil expects raw address bytes as hex (same format as captured API examples)
    const changeAddress = Buffer.from(addr.to_bytes()).toString('hex');

    const { utxos } = await getUtxosExtract(addr, this.blockfrost, { maxUtxos: 20 });

    if (utxos.length === 0) {
      throw new Error(
        `Treasury wallet has no UTxOs at ${treasuryAddressBech32.slice(0, 20)}…. Cannot build Anvil transaction.`
      );
    }

    return { changeAddress, utxos };
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
