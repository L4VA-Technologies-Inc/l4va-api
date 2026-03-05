import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DistributionCalculationService } from '../distribution/distribution-calculation.service';

interface AcquirerTransaction {
  id: string;
  userId: string;
  amount: number; // ADA sent
}

interface ContributorTransaction {
  id: string;
  userId: string;
  assets: {
    policyId: string;
    assetName: string | null;
    quantity: number;
    floorPrice: number; // ADA value per unit
  }[];
}

interface SimulationInput {
  vault: {
    id: string;
    name: string;
    ft_token_supply: number; // Base supply (e.g., 1,000,000)
    ft_token_decimals: number; // Starting decimals (6, 7, or 8)
    tokens_for_acquires: number; // Percentage (0-100)
    liquidity_pool_contribution: number; // Percentage (0-100)
  };
  acquisitionTransactions: AcquirerTransaction[];
  contributionTransactions: ContributorTransaction[];
  minLpLiquidity?: number; // Lovelace, defaults to 1M (1 ADA)
}

/**
 * Acquire-to-Governance Transition Simulator
 *
 * This controller simulates the EXACT production flow from executeAcquireToGovernanceTransition
 * Use it to understand decimal requirements and test different transaction scenarios
 */
@ApiTags('diagnostics')
@Controller('diagnostics/acquire-transition-test')
export class AcquireTransitionTestController {
  constructor(private readonly distributionCalculationService: DistributionCalculationService) {}

  /**
   * Simulate the complete Acquire-to-Governance transition flow
   * Follows the exact logic from LifecycleService.executeAcquireToGovernanceTransition
   */
  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Simulate acquire-to-governance transition',
    description: 'Simulates the complete transition flow with your transaction data',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        vault: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'vault-001' },
            name: { type: 'string', example: 'Test Vault' },
            ft_token_supply: { type: 'number', example: 1000000 },
            ft_token_decimals: { type: 'number', example: 6 },
            tokens_for_acquires: { type: 'number', example: 50 },
            liquidity_pool_contribution: { type: 'number', example: 20 },
          },
        },
        acquisitionTransactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'tx-001' },
              userId: { type: 'string', example: 'user-001' },
              amount: { type: 'number', example: 200 },
            },
          },
        },
        contributionTransactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'tx-contrib-001' },
              userId: { type: 'string', example: 'user-002' },
              assets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    policyId: { type: 'string' },
                    assetName: { type: 'string', nullable: true },
                    quantity: { type: 'number' },
                    floorPrice: { type: 'number' },
                  },
                },
              },
            },
          },
        },
        minLpLiquidity: { type: 'number', example: 1000000 },
      },
    },
  })
  async simulateTransition(@Body() input: SimulationInput): Promise<any> {
    const { vault, acquisitionTransactions, contributionTransactions, minLpLiquidity = 1_000_000 } = input;

    const logs: string[] = [];
    const log = (message: string) => {
      console.log(message);
      logs.push(message);
    };

    // STEP 1: Calculate total ADA acquired
    const totalAcquiredAda = acquisitionTransactions.reduce((sum, tx) => sum + tx.amount, 0);
    log(`Total ADA acquired: ${totalAcquiredAda} ADA`);

    // STEP 2: Calculate total contributed value (TVL)
    const contributionValueByTransaction: Record<string, number> = {};
    const userContributedValueMap: Record<string, number> = {};

    contributionTransactions.forEach(tx => {
      const txValue = tx.assets.reduce((sum, asset) => sum + asset.quantity * asset.floorPrice, 0);
      contributionValueByTransaction[tx.id] = txValue;
      userContributedValueMap[tx.userId] = (userContributedValueMap[tx.userId] || 0) + txValue;
    });

    const totalContributedValueAda = Object.values(contributionValueByTransaction).reduce((sum, v) => sum + v, 0);
    log(`Total contributed value (TVL): ${totalContributedValueAda} ADA`);

    // Use raw units for claim calculations (on-chain minting needs decimal-adjusted amounts)
    const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

    log(`Initial VT Supply (with ${vault.ft_token_decimals} decimals): ${vtSupply}`);
    log(`Assets Offered Percent: ${ASSETS_OFFERED_PERCENT * 100}%`);
    log(`LP Percent: ${LP_PERCENT * 100}%`);

    // STEP 3: Calculate LP Tokens
    const lpResult = this.distributionCalculationService.calculateLpTokens({
      vtSupply,
      totalAcquiredAda,
      totalContributedValueAda,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
    });

    log(`\n=== LP Calculation ===`);
    log(`FDV: ${lpResult.fdv} ADA`);
    log(`VT Price: ${lpResult.vtPrice} ADA`);
    log(`LP ADA Amount: ${lpResult.lpAdaAmount} ADA`);
    log(`LP VT Amount: ${lpResult.lpVtAmount}`);
    log(`Adjusted LP VT Amount: ${lpResult.adjustedVtLpAmount}`);
    log(`ADA Pair Multiplier: ${lpResult.adaPairMultiplier}`);
    log(`LP Multiplier Ratio: ${lpResult.lpMultiplierRatio}`);

    // Check if LP is configured and validate minimum threshold
    const lpAdaInLovelace = Math.floor(lpResult.lpAdaAmount * 1_000_000);

    if (vault.liquidity_pool_contribution > 0 && lpAdaInLovelace < minLpLiquidity) {
      log(`\n❌ VAULT WOULD FAIL: LP configured but insufficient liquidity`);
      log(`LP ADA: ${lpResult.lpAdaAmount} ADA (${lpAdaInLovelace} lovelace)`);
      log(`Minimum required: ${minLpLiquidity / 1_000_000} ADA (${minLpLiquidity} lovelace)`);

      return {
        success: false,
        reason: 'INSUFFICIENT_LP_LIQUIDITY',
        lpAdaAmount: lpResult.lpAdaAmount,
        lpAdaInLovelace,
        minLpLiquidity,
        minLpLiquidityAda: minLpLiquidity / 1_000_000,
        logs,
      };
    }

    // STEP 3.5: Check decimal precision BEFORE creating any claims
    const minAcquirerMultiplier =
      vtSupply > 0 && totalAcquiredAda > 0
        ? Math.floor(((vtSupply - lpResult.lpVtAmount) * ASSETS_OFFERED_PERCENT) / totalAcquiredAda / 1_000_000)
        : Infinity;

    log(`\n=== Pre-Claim Decimal Check ===`);
    log(`Min Acquirer Multiplier: ${minAcquirerMultiplier === Infinity ? 'N/A' : minAcquirerMultiplier}`);
    log(`LP Multiplier Ratio: ${lpResult.lpMultiplierRatio?.toFixed(4) || 'N/A'}`);
    log(`Current Decimals: ${vault.ft_token_decimals}`);

    const optimalDecimals = this.distributionCalculationService.calculateOptimalDecimals(
      vault.ft_token_supply,
      minAcquirerMultiplier === Infinity ? undefined : minAcquirerMultiplier,
      lpResult.lpMultiplierRatio
    );

    log(`Optimal Decimals: ${optimalDecimals}`);

    // Upgrade decimals if needed (before creating any claims)
    let finalVtSupply = vtSupply;
    let finalLpVtAmount = lpResult.lpVtAmount;
    let finalAdjustedVtLpAmount = lpResult.adjustedVtLpAmount;
    let finalAdaPairMultiplier = lpResult.adaPairMultiplier;
    let finalDecimals = vault.ft_token_decimals;

    if (optimalDecimals > vault.ft_token_decimals) {
      const oldDecimals = vault.ft_token_decimals;
      const decimalMultiplier = Math.pow(10, optimalDecimals - oldDecimals);

      log(`\n🔄 Upgrading decimals from ${oldDecimals} to ${optimalDecimals} (multiplier: ${decimalMultiplier}x)`);

      finalDecimals = optimalDecimals;
      finalVtSupply = vault.ft_token_supply * Math.pow(10, optimalDecimals);

      const recalculatedLp = this.distributionCalculationService.calculateLpTokens({
        vtSupply: finalVtSupply,
        totalAcquiredAda,
        totalContributedValueAda,
        assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
        lpPercent: LP_PERCENT,
      });

      finalLpVtAmount = recalculatedLp.lpVtAmount;
      finalAdjustedVtLpAmount = recalculatedLp.adjustedVtLpAmount;
      finalAdaPairMultiplier = recalculatedLp.adaPairMultiplier;

      log(`Recalculated with ${optimalDecimals} decimals:`);
      log(`  VT Supply: ${finalVtSupply}`);
      log(`  LP VT Amount: ${finalLpVtAmount}`);
      log(`  Adjusted LP VT Amount: ${finalAdjustedVtLpAmount}`);
      log(`  ADA Pair Multiplier: ${finalAdaPairMultiplier}`);
    } else if (optimalDecimals < vault.ft_token_decimals) {
      log(`\n✅ Keeping decimals at ${vault.ft_token_decimals} (optimal: ${optimalDecimals}, but never downgrade)`);
    }

    // STEP 4: Create LP claim
    const lpClaim =
      finalAdjustedVtLpAmount > 0 && lpResult.lpAdaAmount > 0
        ? {
            type: 'LP',
            vtAmount: finalAdjustedVtLpAmount,
            adaAmount: lpResult.lpAdaAmount,
            lovelaceAmount: lpAdaInLovelace,
          }
        : null;

    if (lpClaim) {
      log(`\n=== LP Claim ===`);
      log(`VT Amount: ${lpClaim.vtAmount}`);
      log(`ADA Amount: ${lpClaim.adaAmount} ADA (${lpClaim.lovelaceAmount} lovelace)`);
    } else {
      log(`\n=== No LP Claim ===(LP %: ${vault.liquidity_pool_contribution}%)`);
    }

    // STEP 5: Create acquirer claims
    log(`\n=== Acquirer Claims ===`);
    const acquirerClaims = [];
    const acquirerMultipliers = [];

    for (const tx of acquisitionTransactions) {
      const adaSent = tx.amount;

      if (adaSent <= 0) continue;

      const result = this.distributionCalculationService.calculateAcquirerTokens({
        adaSent,
        totalAcquiredValueAda: totalAcquiredAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: finalLpVtAmount,
        vtPrice: lpResult.vtPrice,
        vtSupply: finalVtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      acquirerMultipliers.push(result.multiplier);

      acquirerClaims.push({
        transactionId: tx.id,
        userId: tx.userId,
        adaSent,
        vtReceived: result.vtReceived,
        multiplier: result.multiplier,
      });
    }

    // Normalize to minimum multiplier
    if (acquirerClaims.length > 0) {
      const minMultiplier = Math.min(...acquirerMultipliers);
      log(`Min Acquirer Multiplier: ${minMultiplier}`);

      acquirerClaims.forEach(claim => {
        claim.vtReceived = minMultiplier * claim.adaSent * 1_000_000;
        claim.multiplier = minMultiplier;
      });

      log(`Acquirer Claims (${acquirerClaims.length} transactions):`);
      acquirerClaims.forEach((claim, idx) => {
        log(
          `  ${idx + 1}. TX ${claim.transactionId}: ${claim.adaSent} ADA → ${claim.vtReceived} VT (multiplier: ${claim.multiplier})`
        );
      });
    }

    // STEP 6: Create contributor claims
    log(`\n=== Contributor Claims ===`);
    const contributorClaims = [];

    for (const tx of contributionTransactions) {
      const txValueAda = contributionValueByTransaction[tx.id] || 0;

      if (txValueAda <= 0) continue;

      const userTotalValue = userContributedValueMap[tx.userId] || 0;

      const result = this.distributionCalculationService.calculateContributorTokens({
        txContributedValue: txValueAda,
        userTotalValue,
        totalAcquiredAda,
        totalTvl: totalContributedValueAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: finalLpVtAmount,
        vtSupply: finalVtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      contributorClaims.push({
        transactionId: tx.id,
        userId: tx.userId,
        contributedValue: txValueAda,
        vtAmount: result.vtAmount,
        lovelaceAmount: result.lovelaceAmount,
        adaAmount: result.lovelaceAmount / 1_000_000,
        vtMultiplier: result.vtAmount / txValueAda,
        adaMultiplier: result.lovelaceAmount / txValueAda / 1_000_000,
      });
    }

    if (contributorClaims.length > 0) {
      log(`Contributor Claims (${contributorClaims.length} transactions):`);
      contributorClaims.forEach((claim, idx) => {
        log(
          `  ${idx + 1}. TX ${claim.transactionId}: ${claim.contributedValue} ADA value → ` +
            `${claim.vtAmount} VT + ${claim.adaAmount.toFixed(2)} ADA ` +
            `(VT mult: ${claim.vtMultiplier.toFixed(4)}, ADA mult: ${claim.adaMultiplier.toFixed(4)})`
        );
      });
    }

    // STEP 7: Calculate multipliers for on-chain metadata
    log(`\n=== On-Chain Multipliers ===`);

    // Group contributor assets by policy for multipliers
    const assetMultipliers: Map<
      string,
      Map<string, { vtMultiplier: number; adaMultiplier: number; count: number }>
    > = new Map();

    // Recalculated claim amounts (to match smart contract calculation)
    const recalculatedClaimAmounts = new Map<string, number>();
    const recalculatedLovelaceAmounts = new Map<string, number>();

    contributionTransactions.forEach(tx => {
      const claim = contributorClaims.find(c => c.transactionId === tx.id);
      if (!claim) return;

      const txValueAda = contributionValueByTransaction[tx.id];
      if (txValueAda <= 0) return;

      let recalculatedVtAmount = 0;
      let recalculatedLovelace = 0;

      tx.assets.forEach(asset => {
        const assetValue = asset.quantity * asset.floorPrice;
        const vtSharePerUnit = Math.floor((claim.vtAmount * assetValue) / txValueAda / asset.quantity);
        const adaSharePerUnit = Math.floor((claim.lovelaceAmount * assetValue) / txValueAda / asset.quantity);

        // Recalculate using qty × multiplier (matches smart contract)
        recalculatedVtAmount += asset.quantity * vtSharePerUnit;
        recalculatedLovelace += asset.quantity * adaSharePerUnit;

        if (!assetMultipliers.has(asset.policyId)) {
          assetMultipliers.set(asset.policyId, new Map());
        }

        const policyMap = assetMultipliers.get(asset.policyId);
        const key = asset.assetName || '';

        if (!policyMap.has(key)) {
          policyMap.set(key, { vtMultiplier: vtSharePerUnit, adaMultiplier: adaSharePerUnit, count: 0 });
        }

        const existing = policyMap.get(key);
        existing.count++;
      });

      // Store recalculated amounts
      recalculatedClaimAmounts.set(tx.id, recalculatedVtAmount);
      recalculatedLovelaceAmounts.set(tx.id, recalculatedLovelace);

      // Update the claim with recalculated amounts
      claim.vtAmount = recalculatedVtAmount;
      claim.lovelaceAmount = recalculatedLovelace;
      claim.adaAmount = recalculatedLovelace / 1_000_000;
      claim.vtMultiplier = recalculatedVtAmount / txValueAda;
      claim.adaMultiplier = recalculatedLovelace / txValueAda / 1_000_000;
    });

    // Log recalculation summary
    if (recalculatedClaimAmounts.size > 0) {
      log(`\n=== Claim Recalculation (qty × multiplier) ===`);
      contributionTransactions.forEach(tx => {
        const recalcVt = recalculatedClaimAmounts.get(tx.id);
        if (recalcVt !== undefined) {
          log(`  TX ${tx.id}: VT recalculated to ${recalcVt} (using qty × multiplier formula)`);
        }
      });
    }

    const acquireMultiplier: [string, string | null, number][] = [];
    const adaDistribution: [string, string | null, number][] = [];

    assetMultipliers.forEach((policyMap, policyId) => {
      policyMap.forEach((data, assetName) => {
        acquireMultiplier.push([policyId, assetName || null, data.vtMultiplier]);
        adaDistribution.push([policyId, assetName || null, data.adaMultiplier]);
        log(
          `  Policy: ${policyId.substring(0, 16)}..., Asset: ${assetName || '(policy)'}, VT: ${data.vtMultiplier}, ADA: ${data.adaMultiplier}`
        );
      });
    });

    // Add acquirer multiplier (ADA policy)
    if (acquirerClaims.length > 0) {
      const acquirerMultiplier = acquirerClaims[0].multiplier;
      acquireMultiplier.push(['', '', acquirerMultiplier]);
      log(`  ADA Acquirer Multiplier: ${acquirerMultiplier}`);
    }

    // STEP 8: Final summary
    log(`\n=== SIMULATION COMPLETE ===`);
    log(`✅ Vault would transition to GOVERNANCE (locked) phase`);
    log(`Final Decimals: ${finalDecimals}`);
    log(`Total VT for Acquirers: ${acquirerClaims.reduce((sum, c) => sum + c.vtReceived, 0)}`);
    log(
      `Total VT for Contributors: ${contributorClaims.reduce((sum, c) => sum + c.vtAmount, 0)} (recalculated using qty × multiplier)`
    );
    log(`Total ADA for Contributors: ${contributorClaims.reduce((sum, c) => sum + c.adaAmount, 0).toFixed(2)} ADA`);
    log(`LP VT Amount: ${finalAdjustedVtLpAmount}`);
    log(
      `\nGrand Total VT Distributed: ${acquirerClaims.reduce((sum, c) => sum + c.vtReceived, 0) + contributorClaims.reduce((sum, c) => sum + c.vtAmount, 0) + finalAdjustedVtLpAmount}`
    );
    log(`Expected Total: ${finalVtSupply}`);
    log(
      `Difference: ${finalVtSupply - (acquirerClaims.reduce((sum, c) => sum + c.vtReceived, 0) + contributorClaims.reduce((sum, c) => sum + c.vtAmount, 0) + finalAdjustedVtLpAmount)}`
    );

    return {
      success: true,
      vault: {
        ...vault,
        finalDecimals,
        decimalUpgraded: finalDecimals > vault.ft_token_decimals,
      },
      totals: {
        totalAcquiredAda,
        totalContributedValueAda,
        fdv: lpResult.fdv,
        vtPrice: lpResult.vtPrice,
      },
      lpResult: {
        fdv: lpResult.fdv,
        vtPrice: lpResult.vtPrice,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: finalLpVtAmount,
        adjustedVtLpAmount: finalAdjustedVtLpAmount,
        adaPairMultiplier: finalAdaPairMultiplier,
        lpMultiplierRatio: lpResult.lpMultiplierRatio,
      },
      claims: {
        lp: lpClaim,
        acquirers: acquirerClaims,
        contributors: contributorClaims,
      },
      onChainMetadata: {
        acquireMultiplier,
        adaDistribution,
        adaPairMultiplier: finalAdaPairMultiplier,
        vaultStatus: 'SUCCESSFUL',
      },
      logs,
    };
  }
}
