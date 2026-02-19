import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { AssetOriginType, AssetType } from '@/types/asset.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { SmartContractVaultStatus, VaultStatus } from '@/types/vault.types';

/**
 * Diagnostic Service
 *
 * Provides testing, simulation, and diagnostic methods for vault operations.
 * These methods are for admin use only and do not modify the database.
 */
@Injectable()
export class DiagnosticService {
  private readonly logger = new Logger(DiagnosticService.name);
  private readonly GROUPING_THRESHOLD = 1;

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly distributionCalculationService: DistributionCalculationService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly vaultManagingService: VaultManagingService
  ) {}

  /**
   * TEST METHOD: Simulate multiplier calculations for a vault without executing the transition
   * This is useful for testing and validation of multiplier calculations
   * @param vaultId - The vault ID to simulate calculations for
   * @returns Simulated multiplier data and asset pricing information
   */
  async simulateVaultMultipliers(vaultId: string): Promise<{
    vault: {
      id: string;
      name: string;
      status: VaultStatus;
      totalAssets: number;
    };
    calculations: {
      totalAcquiredAda: number;
      totalContributedValueAda: number;
      requiredThresholdAda: number;
      meetsThreshold: boolean;
      vtSupply: number;
      assetsOfferedPercent: number;
      lpPercent: number;
    };
    lpTokens: {
      lpAdaAmount: number;
      lpVtAmount: number;
      vtPrice: number;
      fdv: number;
      adjustedVtLpAmount: number;
      adaPairMultiplier: number;
    };
    multipliers: {
      acquireMultiplier: [string, string, number][];
      adaDistribution: [string, string, number][];
      maxMultiplier: number;
      minMultiplier: number;
      maxAdaDistribution: number;
      minAdaDistribution: number;
    };
    groupingDetails: {
      vtMultiplierGroups: {
        policyId: string;
        policyName?: string;
        multiplier: number;
        maxMultiplier: number;
        multiplierVariance: number;
        assetCount: number;
        isGrouped: boolean;
        groupingReason: string;
        assets: Array<{
          assetName: string;
          quantity: number;
          multiplier: number;
        }>;
      }[];
      adaDistributionGroups: {
        policyId: string;
        policyName?: string;
        adaMultiplier: number;
        maxAdaMultiplier: number;
        multiplierVariance: number;
        assetCount: number;
        isGrouped: boolean;
        groupingReason: string;
        assets: Array<{
          assetName: string;
          quantity: number;
          adaMultiplier: number;
        }>;
      }[];
      stats: {
        totalVtGroups: number;
        vtGroupedPolicies: number;
        vtUngroupedAssets: number;
        vtOriginalAssetCount: number;
        vtCompressionRatio: number;
        totalAdaGroups: number;
        adaGroupedPolicies: number;
        adaUngroupedAssets: number;
        adaOriginalAssetCount: number;
        adaCompressionRatio: number;
        mixedValuePolicies: Array<{
          policyId: string;
          vtMultipliers: number[];
          adaMultipliers: number[];
        }>;
      };
    };
    assetPricing: {
      policyId: string;
      assetName: string;
      priceAda: number;
      quantity: number;
      totalValueAda: number;
      isNFT: boolean;
    }[];
    decimals: {
      current: number;
      optimal: number;
      needsUpdate: boolean;
    };
    transactionSize: {
      txSizeBytes: number;
      txSizeKB: number;
      maxSizeBytes: number;
      percentOfMax: number;
      withinLimit: boolean;
      multiplierCount: number;
      adaDistributionCount: number;
      estimatedFee?: number;
      warning?: string;
    };
  }> {
    this.logger.log(`Simulating multiplier calculations for vault ${vaultId}`);

    // Fetch vault with all necessary relations
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['owner', 'assets'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Get all relevant transactions
    const allTransactions = await this.transactionsRepository.find({
      where: {
        vault_id: vault.id,
        type: In([TransactionType.acquire, TransactionType.contribute]),
        status: TransactionStatus.confirmed,
      },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });

    const acquisitionTransactions = allTransactions.filter(tx => tx.type === TransactionType.acquire);
    const contributionTransactions = allTransactions.filter(tx => tx.type === TransactionType.contribute);

    this.logger.log(
      `Found ${allTransactions.length} total transactions: ${acquisitionTransactions.length} acquire, ${contributionTransactions.length} contribute`
    );

    // Calculate total ADA from acquisitions
    let totalAcquiredAda = 0;
    for (const tx of acquisitionTransactions) {
      totalAcquiredAda += tx.amount || 0;
    }

    // Calculate total value of contributed assets
    let totalContributedValueAda = 0;
    const assetPricing: {
      policyId: string;
      assetName: string;
      priceAda: number;
      quantity: number;
      totalValueAda: number;
      isNFT: boolean;
    }[] = [];

    for (const tx of contributionTransactions) {
      if (!tx.user_id) {
        this.logger.warn(`Skipping transaction ${tx.id} - no user_id`);
        continue;
      }

      const txAssets = await this.assetsRepository.find({
        where: {
          transaction: { id: tx.id },
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
      });

      for (const asset of txAssets) {
        try {
          const isNFT = asset.type === AssetType.NFT;
          // Use floor_price from entity first, fallback to dex_price, then 0
          const priceAda = asset.floor_price || asset.dex_price || 0;

          const quantity = asset.quantity || 1;
          const totalValueAda = priceAda * quantity;

          totalContributedValueAda += totalValueAda;

          assetPricing.push({
            policyId: asset.policy_id,
            assetName: asset.asset_id,
            priceAda,
            quantity,
            totalValueAda,
            isNFT,
          });
        } catch (error) {
          this.logger.error(`Error processing asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
        }
      }
    }

    // Use raw units for claim calculations (on-chain minting needs decimal-adjusted amounts)
    const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

    const requiredThresholdAda =
      totalContributedValueAda * vault.tokens_for_acquires * 0.01 * vault.acquire_reserve * 0.01;
    const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

    // Calculate LP tokens
    const lpResult = this.distributionCalculationService.calculateLpTokens({
      vtSupply,
      totalAcquiredAda,
      totalContributedValueAda,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
    });

    // Simulate claim creation to calculate multipliers
    const mockContributorClaims: Partial<Claim>[] = [];
    const mockAcquirerClaims: Partial<Claim>[] = [];

    // Create mock acquirer claims
    for (const tx of acquisitionTransactions) {
      if (!tx.user || !tx.user.id) continue;
      const adaSent = tx.amount || 0;
      if (adaSent <= 0) continue;

      const { vtReceived, multiplier } = this.distributionCalculationService.calculateAcquirerTokens({
        adaSent,
        totalAcquiredValueAda: totalAcquiredAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtPrice: lpResult.vtPrice,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      mockAcquirerClaims.push({
        id: tx.id,
        amount: vtReceived,
        multiplier: multiplier,
        transaction: tx as any,
      });
    }

    // Create mock contributor claims
    const contributionValueByTransaction: Record<string, number> = {};
    const userContributedValueMap: Record<string, number> = {};

    for (const tx of contributionTransactions) {
      if (!tx.user_id) continue;

      const txAssets = await this.assetsRepository.find({
        where: {
          transaction: { id: tx.id },
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
      });

      let transactionValueAda = 0;
      for (const asset of txAssets) {
        try {
          // Use floor_price from entity first, fallback to dex_price, then 0
          const priceAda = asset.floor_price || asset.dex_price || 0;
          const quantity = asset.quantity || 1;
          transactionValueAda += priceAda * quantity;
        } catch (error) {
          this.logger.error(`Error processing asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
        }
      }

      contributionValueByTransaction[tx.id] = transactionValueAda;

      if (!userContributedValueMap[tx.user.id]) {
        userContributedValueMap[tx.user.id] = 0;
      }
      userContributedValueMap[tx.user.id] += transactionValueAda;

      const txValueAda = contributionValueByTransaction[tx.id] || 0;
      if (txValueAda <= 0) continue;

      const userTotalValue = userContributedValueMap[tx.user.id] || 0;

      const contributorResult = this.distributionCalculationService.calculateContributorTokens({
        txContributedValue: txValueAda,
        userTotalValue,
        totalAcquiredAda,
        totalTvl: totalContributedValueAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      // Load assets for this transaction
      tx.assets = txAssets;

      mockContributorClaims.push({
        id: tx.id,
        amount: contributorResult.vtAmount,
        lovelace_amount: contributorResult.lovelaceAmount,
        transaction: tx as any,
      });
    }

    // Calculate multipliers using the distribution service
    const multiplierResult = this.distributionCalculationService.calculateAcquireMultipliers({
      contributorsClaims: mockContributorClaims as Claim[],
      acquirerClaims: mockAcquirerClaims as Claim[],
    });

    // Analyze grouping details
    const groupingDetails = this.analyzeMultiplierGrouping(
      multiplierResult.acquireMultiplier,
      multiplierResult.adaDistribution,
      mockContributorClaims as Claim[]
    );

    // Calculate stats
    const maxMultiplier = Math.max(...multiplierResult.acquireMultiplier.map(m => m[2]), 0);
    const minMultiplier = Math.min(...multiplierResult.acquireMultiplier.map(m => m[2]).filter(m => m > 0), Infinity);
    const maxAdaDistribution = Math.max(...multiplierResult.adaDistribution.map(d => d[2]), 0);
    const minAdaDistribution = Math.min(
      ...multiplierResult.adaDistribution.map(d => d[2]).filter(d => d > 0),
      Infinity
    );

    const minValue = Math.min(
      minMultiplier === Infinity ? 1 : minMultiplier,
      minAdaDistribution === Infinity ? 1 : minAdaDistribution
    );

    const optimalDecimals = this.distributionCalculationService.calculateOptimalDecimals(
      vault.ft_token_supply || 1_000_000,
      minValue
    );

    // Estimate transaction size for the update vault transaction
    let transactionSize: {
      txSizeBytes: number;
      txSizeKB: number;
      maxSizeBytes: number;
      percentOfMax: number;
      withinLimit: boolean;
      multiplierCount: number;
      adaDistributionCount: number;
      warning?: string;
    };

    try {
      const txSizeEstimate = await this.vaultManagingService.estimateUpdateVaultTxSize({
        vault: {
          id: vault.id,
          asset_vault_name: vault.asset_vault_name,
          privacy: vault.privacy,
          contribution_phase_start: vault.contribution_phase_start,
          contribution_duration: vault.contribution_duration,
          value_method: vault.value_method,
        },
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
        acquireMultiplier: multiplierResult.acquireMultiplier,
      });

      transactionSize = {
        ...txSizeEstimate,
        warning: !txSizeEstimate.withinLimit
          ? `⚠️ Transaction size (${txSizeEstimate.txSizeKB} KB) exceeds Cardano limit (16 KB). Transaction will fail!`
          : txSizeEstimate.percentOfMax > 90
            ? `⚠️ Transaction size is ${txSizeEstimate.percentOfMax}% of max limit. Consider reducing assets.`
            : undefined,
      };

      this.logger.log(
        `Transaction size for vault ${vault.id}: ${txSizeEstimate.txSizeBytes} bytes ` +
          `(${txSizeEstimate.percentOfMax}% of max)`
      );
    } catch (error) {
      this.logger.error(`Failed to estimate transaction size for vault ${vault.id}:`, error);
      transactionSize = {
        txSizeBytes: 0,
        txSizeKB: 0,
        maxSizeBytes: 16384,
        percentOfMax: 0,
        withinLimit: false,
        multiplierCount: multiplierResult.acquireMultiplier.length,
        adaDistributionCount: multiplierResult.adaDistribution.length,
        warning: `❌ Failed to estimate transaction size: ${error.message}`,
      };
    }

    return {
      vault: {
        id: vault.id,
        name: vault.name,
        status: vault.vault_status,
        totalAssets: assetPricing.length,
      },
      calculations: {
        totalAcquiredAda,
        totalContributedValueAda,
        requiredThresholdAda,
        meetsThreshold,
        vtSupply,
        assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
        lpPercent: LP_PERCENT,
      },
      lpTokens: {
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtPrice: lpResult.vtPrice,
        fdv: lpResult.fdv,
        adjustedVtLpAmount: lpResult.adjustedVtLpAmount,
        adaPairMultiplier: lpResult.adaPairMultiplier,
      },
      multipliers: {
        acquireMultiplier: multiplierResult.acquireMultiplier,
        adaDistribution: multiplierResult.adaDistribution,
        maxMultiplier,
        minMultiplier: minMultiplier === Infinity ? 0 : minMultiplier,
        maxAdaDistribution,
        minAdaDistribution: minAdaDistribution === Infinity ? 0 : minAdaDistribution,
      },
      groupingDetails,
      assetPricing,
      decimals: {
        current: vault.ft_token_decimals,
        optimal: optimalDecimals,
        needsUpdate: optimalDecimals !== vault.ft_token_decimals,
      },
      transactionSize,
    };
  }

  /**
   * TEST METHOD: Simulate multi-batch distribution for a vault
   * Shows how multipliers would be split across multiple transactions
   * @param vaultId - The vault ID to simulate batching for
   * @returns Detailed batching simulation results
   */
  async simulateMultiBatchDistribution(vaultId: string): Promise<{
    vault: {
      id: string;
      name: string;
      status: string;
    };
    summary: {
      totalMultipliers: number;
      totalAdaDistribution: number;
      needsBatching: boolean;
      totalBatches: number;
      estimatedTimeMinutes: number;
      totalClaims: number;
    };
    singleTransactionAttempt: {
      withinLimit: boolean;
      txSizeBytes: number;
      txSizeKB: number;
      percentOfMax: number;
    };
    batches: Array<{
      batchNumber: number;
      multiplierCount: number;
      adaDistributionCount: number;
      multiplierRange: {
        first: [string, string | null, number];
        last: [string, string | null, number];
      };
      estimatedTxSize?: {
        txSizeBytes: number;
        txSizeKB: number;
        percentOfMax: number;
        withinLimit: boolean;
      };
    }>;
    rawData: {
      acquireMultiplier: [string, string | null, number][];
      adaDistribution: [string, string, number][];
      adaPairMultiplier: number;
    };
  }> {
    this.logger.log(`[TEST] Simulating multi-batch distribution for vault ${vaultId}`);

    // First, run the regular simulation to get multipliers
    const simulation = await this.simulateVaultMultipliers(vaultId);

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'name',
        'asset_vault_name',
        'privacy',
        'contribution_phase_start',
        'contribution_duration',
        'value_method',
        'vault_status',
      ],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    const acquireMultiplier = simulation.multipliers.acquireMultiplier;
    const adaDistribution = simulation.multipliers.adaDistribution;
    const adaPairMultiplier = simulation.lpTokens.adaPairMultiplier;

    // Single transaction info
    const singleTxAttempt = {
      withinLimit: simulation.transactionSize.withinLimit,
      txSizeBytes: simulation.transactionSize.txSizeBytes,
      txSizeKB: simulation.transactionSize.txSizeKB,
      percentOfMax: simulation.transactionSize.percentOfMax,
    };

    // Always single batch (multi-batch has been removed)
    const batches = [
      {
        batchNumber: 1,
        multiplierCount: acquireMultiplier.length,
        adaDistributionCount: adaDistribution.length,
        multiplierRange: {
          first: acquireMultiplier[0],
          last: acquireMultiplier[acquireMultiplier.length - 1],
        },
        estimatedTxSize: singleTxAttempt,
      },
    ];

    // Simulate claims that would be created
    const simulatedClaims = await this.simulateClaimsForVault(vaultId, simulation);

    return {
      vault: {
        id: vault.id,
        name: vault.name,
        status: vault.vault_status,
      },
      summary: {
        totalMultipliers: acquireMultiplier.length,
        totalAdaDistribution: adaDistribution.length,
        needsBatching: false, // Multi-batch removed
        totalBatches: 1,
        estimatedTimeMinutes: 5,
        totalClaims: simulatedClaims.summary.totalClaims,
      },
      singleTransactionAttempt: singleTxAttempt,
      batches,
      claims: simulatedClaims,
      rawData: {
        acquireMultiplier,
        adaDistribution,
        adaPairMultiplier,
      },
    } as any;
  }

  /**
   * Simulate claims that would be created for a vault distribution
   * Does not save anything to the database
   */
  private async simulateClaimsForVault(
    vaultId: string,
    simulation: Awaited<ReturnType<typeof this.simulateVaultMultipliers>>
  ): Promise<{
    summary: {
      totalClaims: number;
      acquirerClaimsCount: number;
      contributorClaimsCount: number;
      lpClaimCount: number;
      totalVtDistributed: number;
      totalAdaDistributed: number;
    };
    lpClaim: {
      type: string;
      vtAmount: number;
      adaAmount: number;
      adaPairMultiplier: number;
    } | null;
    acquirerClaims: Array<{
      userId: string;
      userAddress: string;
      transactionId: string;
      txHash: string;
      type: string;
      vtAmount: number;
      adaSent: number;
      multiplier: number;
    }>;
    contributorClaims: Array<{
      userId: string;
      userAddress: string;
      transactionId: string;
      txHash: string;
      type: string;
      vtAmount: number;
      adaAmount: number;
      contributedValueAda: number;
      assetCount: number;
      assets: Array<{
        policyId: string;
        assetName: string;
        quantity: number;
        priceAda: number;
      }>;
    }>;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'tokens_for_acquires', 'liquidity_pool_contribution', 'ft_token_supply', 'ft_token_decimals'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Get transactions
    const allTransactions = await this.transactionsRepository.find({
      where: {
        vault_id: vault.id,
        type: In([TransactionType.acquire, TransactionType.contribute]),
        status: TransactionStatus.confirmed,
      },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });

    const acquisitionTransactions = allTransactions.filter(tx => tx.type === TransactionType.acquire);
    const contributionTransactions = allTransactions.filter(tx => tx.type === TransactionType.contribute);

    // Use raw units for claim calculations (on-chain minting needs decimal-adjusted amounts)
    const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
    const ASSETS_OFFERED_PERCENT = (vault.tokens_for_acquires || 0) / 100;
    const lpResult = simulation.lpTokens;
    const totalAcquiredAda = simulation.calculations.totalAcquiredAda;
    const totalContributedValueAda = simulation.calculations.totalContributedValueAda;

    // Simulate acquirer claims
    const acquirerClaims: Array<{
      userId: string;
      userAddress: string;
      transactionId: string;
      txHash: string;
      type: string;
      vtAmount: number;
      adaSent: number;
      multiplier: number;
    }> = [];

    for (const tx of acquisitionTransactions) {
      if (!tx.user?.id) continue;

      const adaSent = tx.amount || 0;
      if (adaSent <= 0) continue;

      const { vtReceived, multiplier } = this.distributionCalculationService.calculateAcquirerTokens({
        adaSent,
        totalAcquiredValueAda: totalAcquiredAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtPrice: lpResult.vtPrice,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      acquirerClaims.push({
        userId: tx.user.id,
        userAddress: tx.user.address || 'unknown',
        transactionId: tx.id,
        txHash: tx.tx_hash || 'unknown',
        type: 'ACQUIRER',
        vtAmount: vtReceived,
        adaSent,
        multiplier,
      });
    }

    // Normalize multipliers (use minimum)
    if (acquirerClaims.length > 0) {
      const minMultiplier = Math.min(...acquirerClaims.map(c => c.multiplier));
      for (const claim of acquirerClaims) {
        claim.vtAmount = minMultiplier * claim.adaSent * 1_000_000;
        claim.multiplier = minMultiplier;
      }
    }

    // Simulate contributor claims
    const contributorClaims: Array<{
      userId: string;
      userAddress: string;
      transactionId: string;
      txHash: string;
      type: string;
      vtAmount: number;
      adaAmount: number;
      contributedValueAda: number;
      assetCount: number;
      assets: Array<{
        policyId: string;
        assetName: string;
        quantity: number;
        priceAda: number;
      }>;
    }> = [];

    // Build user value map first
    const userContributedValueMap: Record<string, number> = {};
    const contributionValueByTransaction: Record<string, number> = {};
    const assetsByTransaction: Record<string, any[]> = {};

    for (const tx of contributionTransactions) {
      if (!tx.user?.id) continue;

      const txAssets = await this.assetsRepository.find({
        where: {
          transaction: { id: tx.id },
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
      });

      assetsByTransaction[tx.id] = txAssets;

      let transactionValueAda = 0;
      for (const asset of txAssets) {
        const priceAda = asset.floor_price || asset.dex_price || 0;
        const quantity = asset.quantity || 1;
        transactionValueAda += priceAda * quantity;
      }

      contributionValueByTransaction[tx.id] = transactionValueAda;

      if (!userContributedValueMap[tx.user.id]) {
        userContributedValueMap[tx.user.id] = 0;
      }
      userContributedValueMap[tx.user.id] += transactionValueAda;
    }

    // Now create contributor claims
    for (const tx of contributionTransactions) {
      if (!tx.user?.id) continue;

      const txValueAda = contributionValueByTransaction[tx.id] || 0;
      if (txValueAda <= 0) continue;

      const userTotalValue = userContributedValueMap[tx.user.id] || 0;

      const contributorResult = this.distributionCalculationService.calculateContributorTokens({
        txContributedValue: txValueAda,
        userTotalValue,
        totalAcquiredAda,
        totalTvl: totalContributedValueAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      const txAssets = assetsByTransaction[tx.id] || [];

      contributorClaims.push({
        userId: tx.user.id,
        userAddress: tx.user.address || 'unknown',
        transactionId: tx.id,
        txHash: tx.tx_hash || 'unknown',
        type: 'CONTRIBUTOR',
        vtAmount: contributorResult.vtAmount,
        adaAmount: contributorResult.lovelaceAmount / 1_000_000, // Convert to ADA for readability
        contributedValueAda: txValueAda,
        assetCount: txAssets.length,
        assets: txAssets.map(a => ({
          policyId: a.policy_id,
          assetName: a.asset_id,
          quantity: a.quantity || 1,
          priceAda: a.floor_price || a.dex_price || 0,
        })),
      });
    }

    // LP claim info
    const lpClaim =
      lpResult.lpAdaAmount > 0 && lpResult.lpVtAmount > 0
        ? {
            type: 'LP',
            vtAmount: lpResult.adjustedVtLpAmount,
            adaAmount: lpResult.lpAdaAmount,
            adaPairMultiplier: lpResult.adaPairMultiplier,
          }
        : null;

    // Calculate totals
    const totalVtDistributed =
      acquirerClaims.reduce((sum, c) => sum + c.vtAmount, 0) +
      contributorClaims.reduce((sum, c) => sum + c.vtAmount, 0) +
      (lpClaim?.vtAmount || 0);

    const totalAdaDistributed = contributorClaims.reduce((sum, c) => sum + c.adaAmount, 0) + (lpClaim?.adaAmount || 0);

    return {
      summary: {
        totalClaims: acquirerClaims.length + contributorClaims.length + (lpClaim ? 1 : 0),
        acquirerClaimsCount: acquirerClaims.length,
        contributorClaimsCount: contributorClaims.length,
        lpClaimCount: lpClaim ? 1 : 0,
        totalVtDistributed,
        totalAdaDistributed,
      },
      lpClaim,
      acquirerClaims,
      contributorClaims,
    };
  }

  /**
   * Analyze multiplier grouping to provide detailed insights
   * Now uses price-based grouping: assets with the same price within a policy are grouped together
   */
  private analyzeMultiplierGrouping(
    acquireMultiplier: [string, string | null, number][],
    adaDistribution: [string, string, number][],
    contributorClaims: Claim[]
  ): {
    vtMultiplierGroups: Array<{
      policyId: string;
      policyName?: string;
      multiplier: number;
      maxMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{
        assetName: string;
        quantity: number;
        multiplier: number;
      }>;
    }>;
    adaDistributionGroups: Array<{
      policyId: string;
      policyName?: string;
      adaMultiplier: number;
      maxAdaMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{
        assetName: string;
        quantity: number;
        adaMultiplier: number;
      }>;
    }>;
    stats: {
      totalVtGroups: number;
      vtGroupedPolicies: number;
      vtUngroupedAssets: number;
      vtOriginalAssetCount: number;
      vtCompressionRatio: number;
      totalAdaGroups: number;
      adaGroupedPolicies: number;
      adaUngroupedAssets: number;
      adaOriginalAssetCount: number;
      adaCompressionRatio: number;
      mixedValuePolicies: Array<{
        policyId: string;
        vtMultipliers: number[];
        adaMultipliers: number[];
      }>;
    };
  } {
    // Track assets by (policy, price) for price-based analysis
    interface AssetWithPrice {
      assetName: string;
      quantity: number;
      multiplier: number;
      adaMultiplier: number;
      price: number;
    }

    const assetsByPolicyAndPrice = new Map<string, AssetWithPrice[]>();

    // Collect all assets with their data and prices
    const allVtAssets = new Map<
      string,
      {
        policyId: string;
        assetName: string;
        quantity: number;
        multiplier: number;
        price: number;
      }
    >();
    const allAdaAssets = new Map<
      string,
      {
        policyId: string;
        assetName: string;
        quantity: number;
        adaMultiplier: number;
        price: number;
      }
    >();

    for (const claim of contributorClaims) {
      if (!claim.transaction?.assets) continue;

      const contributorLovelaceAmount = claim?.lovelace_amount || 0;
      const baseVtShare = Math.floor(claim.amount / claim.transaction.assets.length);
      const vtRemainder = claim.amount - baseVtShare * claim.transaction.assets.length;
      const baseAdaShare = Math.floor(contributorLovelaceAmount / claim.transaction.assets.length);
      const adaRemainder = contributorLovelaceAmount - baseAdaShare * claim.transaction.assets.length;

      claim.transaction.assets.forEach((asset, index) => {
        const vtShare = baseVtShare + (index < vtRemainder ? 1 : 0);
        const assetQuantity = Number(asset.quantity) || 1;
        const vtSharePerUnit = Math.floor(vtShare / assetQuantity);

        const adaShare = baseAdaShare + (index < adaRemainder ? 1 : 0);
        const adaSharePerUnit = Math.floor(adaShare / assetQuantity);

        // Get asset price
        const price = Number(asset.floor_price) || Number(asset.dex_price) || Number(asset.listing_price) || 0;
        const key = `${asset.policy_id}:${asset.asset_id}`;

        allVtAssets.set(key, {
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          quantity: assetQuantity,
          multiplier: vtSharePerUnit,
          price,
        });

        allAdaAssets.set(key, {
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          quantity: assetQuantity,
          adaMultiplier: adaSharePerUnit,
          price,
        });

        // Group by policy AND price
        const groupKey = `${asset.policy_id}:${price}`;
        if (!assetsByPolicyAndPrice.has(groupKey)) {
          assetsByPolicyAndPrice.set(groupKey, []);
        }
        assetsByPolicyAndPrice.get(groupKey)!.push({
          assetName: asset.asset_id,
          quantity: assetQuantity,
          multiplier: vtSharePerUnit,
          adaMultiplier: adaSharePerUnit,
          price,
        });
      });
    }

    // Group price buckets by policy
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, AssetWithPrice[]>;
        totalAssets: number;
      }
    >();

    for (const [groupKey, assets] of assetsByPolicyAndPrice.entries()) {
      const [policyId, priceStr] = groupKey.split(':');
      const price = Number(priceStr);

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, { priceGroups: new Map(), totalAssets: 0 });
      }
      const policyData = policiesData.get(policyId)!;
      policyData.priceGroups.set(price, assets);
      policyData.totalAssets += assets.length;
    }

    // Build VT multiplier group details
    const vtMultiplierGroups: Array<{
      policyId: string;
      policyName?: string;
      multiplier: number;
      maxMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{
        assetName: string;
        quantity: number;
        multiplier: number;
      }>;
    }> = [];

    const adaDistributionGroups: Array<{
      policyId: string;
      policyName?: string;
      adaMultiplier: number;
      maxAdaMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{
        assetName: string;
        quantity: number;
        adaMultiplier: number;
      }>;
    }> = [];

    for (const [policyId, policyData] of policiesData.entries()) {
      const { priceGroups, totalAssets } = policyData;
      const uniquePrices = priceGroups.size;
      const meetsThreshold = totalAssets >= this.GROUPING_THRESHOLD;

      // Collect all assets for this policy
      const allPolicyAssets: AssetWithPrice[] = [];
      for (const assets of priceGroups.values()) {
        allPolicyAssets.push(...assets);
      }

      const vtMultipliers = allPolicyAssets.map(a => a.multiplier);
      const adaMultipliers = allPolicyAssets.map(a => a.adaMultiplier);
      const minVtMultiplier = Math.min(...vtMultipliers);
      const maxVtMultiplier = Math.max(...vtMultipliers);
      const minAdaMultiplier = Math.min(...adaMultipliers);
      const maxAdaMultiplier = Math.max(...adaMultipliers);
      const vtVariance = maxVtMultiplier - minVtMultiplier;
      const adaVariance = maxAdaMultiplier - minAdaMultiplier;

      // Price-based grouping: group only if single price for all assets in policy
      const isGrouped = uniquePrices === 1 && meetsThreshold;

      let groupingReason: string;
      if (isGrouped) {
        const price = [...priceGroups.keys()][0];
        groupingReason = `Policy-level grouping (${totalAssets} assets, single price: ${price} ADA)`;
      } else if (uniquePrices > 1 && meetsThreshold) {
        const priceList = [...priceGroups.keys()].slice(0, 5).join(', ');
        groupingReason = `NOT grouped - ${uniquePrices} different prices (${priceList}${uniquePrices > 5 ? '...' : ''})`;
      } else {
        groupingReason = `Asset-level entries (${totalAssets} assets < ${this.GROUPING_THRESHOLD} threshold)`;
      }

      vtMultiplierGroups.push({
        policyId,
        multiplier: minVtMultiplier,
        maxMultiplier: maxVtMultiplier,
        multiplierVariance: vtVariance,
        assetCount: totalAssets,
        isGrouped,
        groupingReason,
        assets: allPolicyAssets.map(a => ({
          assetName: a.assetName,
          quantity: a.quantity,
          multiplier: a.multiplier,
        })),
      });

      adaDistributionGroups.push({
        policyId,
        adaMultiplier: minAdaMultiplier,
        maxAdaMultiplier,
        multiplierVariance: adaVariance,
        assetCount: totalAssets,
        isGrouped,
        groupingReason,
        assets: allPolicyAssets.map(a => ({
          assetName: a.assetName,
          quantity: a.quantity,
          adaMultiplier: a.adaMultiplier,
        })),
      });
    }

    // Detect mixed-value policies (policies with different prices)
    const mixedValuePolicies: Array<{
      policyId: string;
      vtMultipliers: number[];
      adaMultipliers: number[];
    }> = [];

    for (const [policyId, policyData] of policiesData.entries()) {
      if (policyData.priceGroups.size > 1) {
        const allAssets: AssetWithPrice[] = [];
        for (const assets of policyData.priceGroups.values()) {
          allAssets.push(...assets);
        }
        const vtMults = [...new Set(allAssets.map(a => a.multiplier))].sort((a, b) => b - a);
        const adaMults = [...new Set(allAssets.map(a => a.adaMultiplier))].sort((a, b) => b - a);
        mixedValuePolicies.push({
          policyId,
          vtMultipliers: vtMults,
          adaMultipliers: adaMults,
        });
      }
    }

    // Calculate compression statistics
    const vtOriginalAssetCount = allVtAssets.size;
    const vtFinalEntryCount = acquireMultiplier.filter(m => m[0] !== '').length;
    const vtGroupedPolicies = vtMultiplierGroups.filter(g => g.isGrouped).length;
    const vtUngroupedAssets = vtMultiplierGroups.filter(g => !g.isGrouped).reduce((sum, g) => sum + g.assetCount, 0);

    const adaOriginalAssetCount = allAdaAssets.size;
    const adaFinalEntryCount = adaDistribution.filter(d => d[0] !== '').length;
    const adaGroupedPolicies = adaDistributionGroups.filter(g => g.isGrouped).length;
    const adaUngroupedAssets = adaDistributionGroups
      .filter(g => !g.isGrouped)
      .reduce((sum, g) => sum + g.assetCount, 0);

    return {
      vtMultiplierGroups,
      adaDistributionGroups,
      stats: {
        totalVtGroups: policiesData.size,
        vtGroupedPolicies,
        vtUngroupedAssets,
        vtOriginalAssetCount,
        vtCompressionRatio:
          vtOriginalAssetCount > 0 ? Math.round((1 - vtFinalEntryCount / vtOriginalAssetCount) * 100) : 0,
        totalAdaGroups: policiesData.size,
        adaGroupedPolicies,
        adaUngroupedAssets,
        adaOriginalAssetCount,
        adaCompressionRatio:
          adaOriginalAssetCount > 0 ? Math.round((1 - adaFinalEntryCount / adaOriginalAssetCount) * 100) : 0,
        mixedValuePolicies,
      },
    };
  }
}
