import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { VerifyClaimsQueryDto } from './dto/verify-claims-query.dto';
import {
  ClaimDiscrepancy,
  ClaimVerificationSummary,
  VaultCalculationContext,
  VerifyClaimsResponseDto,
} from './dto/verify-claims.dto';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class ClaimsVerificationService {
  private readonly logger = new Logger(ClaimsVerificationService.name);

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly distributionCalculationService: DistributionCalculationService
  ) {}

  /**
   * Verify vault claims by recalculating from transactions and comparing with database
   * Shows rounding differences and discrepancies between expected and actual amounts
   *
   * @param vaultId - The ID of the vault to verify claims for
   * @param query - Optional filters for user address or ID
   * @returns Detailed verification report with discrepancies
   */
  async verifyClaims(vaultId: string, query?: VerifyClaimsQueryDto): Promise<VerifyClaimsResponseDto> {
    this.logger.log(`Starting claims verification for vault ${vaultId}`);

    // 1. Fetch vault with metadata
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    // 2. Fetch all claims for the vault
    const allClaims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER, ClaimType.LP]),
      },
      relations: ['transaction', 'transaction.assets', 'transaction.user', 'user'],
      order: { created_at: 'ASC' },
    });

    // 3. Fetch all transactions
    const acquisitionTransactions = await this.transactionRepository.find({
      where: {
        vault_id: vaultId,
        type: TransactionType.acquire,
        status: TransactionStatus.confirmed,
      },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });

    const contributionTransactions = await this.transactionRepository.find({
      where: {
        vault_id: vaultId,
        type: TransactionType.contribute,
        status: TransactionStatus.confirmed,
      },
      relations: ['user', 'assets'],
      order: { created_at: 'ASC' },
    });

    // 4. Calculate totals
    const totalAcquiredAda = acquisitionTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);

    // Calculate contributed value from assets
    let totalContributedValueAda = 0;
    const contributionValueByTransaction: Record<string, number> = {};
    const userContributedValueMap: Record<string, number> = {};

    for (const tx of contributionTransactions) {
      const assets = tx.assets || [];
      let txTotalValue = 0;

      for (const asset of assets) {
        const assetValueAda = asset.dex_price
          ? asset.dex_price * asset.quantity
          : asset.floor_price
            ? asset.floor_price * asset.quantity
            : 0;
        txTotalValue += assetValueAda;
      }

      contributionValueByTransaction[tx.id] = txTotalValue;
      totalContributedValueAda += txTotalValue;

      if (tx.user?.id) {
        userContributedValueMap[tx.user.id] = (userContributedValueMap[tx.user.id] || 0) + txTotalValue;
      }
    }

    const vtSupply = (vault.ft_token_supply || 0) * 10 ** (vault.ft_token_decimals || 0);
    const ASSETS_OFFERED_PERCENT = (vault.tokens_for_acquires || 0) * 0.01;
    const LP_PERCENT = (vault.liquidity_pool_contribution || 0) * 0.01;

    // 5. Calculate LP allocation
    const lpResult = this.distributionCalculationService.calculateLpTokens({
      vtSupply,
      totalAcquiredAda,
      totalContributedValueAda,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
    });

    const { lpAdaAmount, lpVtAmount, vtPrice, fdv, adjustedVtLpAmount } = lpResult;

    // 6. Calculate expected claims
    const expectedClaims = new Map<string, { vtAmount: number; lovelaceAmount: number; multiplier?: number }>();
    const expectedClaimsByType = {
      acquirer: [] as any[],
      contributor: [] as any[],
      lp: null as any,
    };

    // Calculate expected acquirer claims
    for (const tx of acquisitionTransactions) {
      if (!tx.user?.id) continue;
      const adaSent = tx.amount || 0;
      if (adaSent <= 0) continue;

      const { vtReceived, multiplier } = this.distributionCalculationService.calculateAcquirerTokens({
        adaSent,
        totalAcquiredValueAda: totalAcquiredAda,
        lpAdaAmount,
        lpVtAmount,
        vtPrice,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      expectedClaimsByType.acquirer.push({
        transactionId: tx.id,
        vtAmount: vtReceived,
        multiplier,
        adaSent,
      });
    }

    // Apply minimum multiplier normalization for acquirers (like in lifecycle service)
    if (expectedClaimsByType.acquirer.length > 0) {
      const minMultiplier = Math.min(...expectedClaimsByType.acquirer.map(c => c.multiplier));
      for (const claim of expectedClaimsByType.acquirer) {
        claim.vtAmount = minMultiplier * claim.adaSent * 1_000_000;
        claim.multiplier = minMultiplier;
        expectedClaims.set(claim.transactionId, {
          vtAmount: claim.vtAmount,
          lovelaceAmount: 0,
          multiplier: claim.multiplier,
        });
      }
    }

    // Calculate expected contributor claims
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
        lpAdaAmount,
        lpVtAmount,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      expectedClaimsByType.contributor.push({
        transactionId: tx.id,
        vtAmount: contributorResult.vtAmount,
        lovelaceAmount: contributorResult.lovelaceAmount,
      });

      expectedClaims.set(tx.id, {
        vtAmount: Math.floor(contributorResult.vtAmount),
        lovelaceAmount: Math.floor(contributorResult.lovelaceAmount),
      });
    }

    // Calculate expected LP claim
    if (lpAdaAmount > 0 && lpVtAmount > 0) {
      expectedClaimsByType.lp = {
        vtAmount: adjustedVtLpAmount,
        lovelaceAmount: Math.floor(lpAdaAmount * 1_000_000),
      };
    }

    // 7. Compare actual vs expected
    const discrepancies: ClaimDiscrepancy[] = [];
    let actualTotalVt = 0;
    let expectedTotalVt = 0;
    let actualTotalAda = 0;
    let expectedTotalAda = 0;
    let maxVtRoundingError = 0;
    let maxAdaRoundingError = 0;

    const claimsByType = {
      acquirer: allClaims.filter(c => c.type === ClaimType.ACQUIRER),
      contributor: allClaims.filter(c => c.type === ClaimType.CONTRIBUTOR),
      lp: allClaims.filter(c => c.type === ClaimType.LP),
    };

    // Check acquirer claims
    for (const claim of claimsByType.acquirer) {
      actualTotalVt += Number(claim.amount) || 0;
      actualTotalAda += Number(claim.lovelace_amount) || 0;

      const expected = claim.transaction?.id ? expectedClaims.get(claim.transaction.id) : null;

      if (expected) {
        expectedTotalVt += expected.vtAmount;
        expectedTotalAda += expected.lovelaceAmount;

        const vtDiff = Math.abs((Number(claim.amount) || 0) - expected.vtAmount);
        const adaDiff = Math.abs((Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount);

        maxVtRoundingError = Math.max(maxVtRoundingError, vtDiff);
        maxAdaRoundingError = Math.max(maxAdaRoundingError, adaDiff);

        if (vtDiff > 1 || adaDiff > 1) {
          // Allow 1 unit rounding tolerance
          discrepancies.push({
            claimId: claim.id,
            userId: claim.user_id,
            transactionId: claim.transaction?.id,
            type: ClaimType.ACQUIRER,
            actualAmount: Number(claim.amount) || 0,
            expectedAmount: expected.vtAmount,
            difference: (Number(claim.amount) || 0) - expected.vtAmount,
            percentageDifference:
              expected.vtAmount > 0 ? (((Number(claim.amount) || 0) - expected.vtAmount) / expected.vtAmount) * 100 : 0,
            actualLovelaceAmount: Number(claim.lovelace_amount) || null,
            expectedLovelaceAmount: expected.lovelaceAmount,
            lovelaceDifference: (Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount,
            actualMultiplier: Number(claim.multiplier) || null,
            expectedMultiplier: expected.multiplier,
            details: {
              adaSent: claim.transaction?.amount,
            },
          });
        }
      } else {
        discrepancies.push({
          claimId: claim.id,
          userId: claim.user_id,
          transactionId: claim.transaction?.id,
          type: ClaimType.ACQUIRER,
          actualAmount: Number(claim.amount) || 0,
          expectedAmount: 0,
          difference: Number(claim.amount) || 0,
          percentageDifference: 100,
          details: {
            reason: 'No corresponding transaction found for recalculation',
          },
        });
      }
    }

    // Check contributor claims
    for (const claim of claimsByType.contributor) {
      actualTotalVt += Number(claim.amount) || 0;
      actualTotalAda += Number(claim.lovelace_amount) || 0;

      const expected = claim.transaction?.id ? expectedClaims.get(claim.transaction.id) : null;

      if (expected) {
        expectedTotalVt += expected.vtAmount;
        expectedTotalAda += expected.lovelaceAmount;

        const vtDiff = Math.abs((Number(claim.amount) || 0) - expected.vtAmount);
        const adaDiff = Math.abs((Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount);

        maxVtRoundingError = Math.max(maxVtRoundingError, vtDiff);
        maxAdaRoundingError = Math.max(maxAdaRoundingError, adaDiff);

        if (vtDiff > 1 || adaDiff > 1) {
          discrepancies.push({
            claimId: claim.id,
            userId: claim.user_id,
            transactionId: claim.transaction?.id,
            type: ClaimType.CONTRIBUTOR,
            actualAmount: Number(claim.amount) || 0,
            expectedAmount: expected.vtAmount,
            difference: (Number(claim.amount) || 0) - expected.vtAmount,
            percentageDifference:
              expected.vtAmount > 0 ? (((Number(claim.amount) || 0) - expected.vtAmount) / expected.vtAmount) * 100 : 0,
            actualLovelaceAmount: Number(claim.lovelace_amount) || null,
            expectedLovelaceAmount: expected.lovelaceAmount,
            lovelaceDifference: (Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount,
            details: {
              contributionValue: claim.transaction?.id ? contributionValueByTransaction[claim.transaction.id] : 0,
            },
          });
        }
      } else {
        discrepancies.push({
          claimId: claim.id,
          userId: claim.user_id,
          transactionId: claim.transaction?.id,
          type: ClaimType.CONTRIBUTOR,
          actualAmount: Number(claim.amount) || 0,
          expectedAmount: 0,
          difference: Number(claim.amount) || 0,
          percentageDifference: 100,
          details: {
            reason: 'No corresponding transaction found for recalculation',
          },
        });
      }
    }

    // Check LP claim
    for (const claim of claimsByType.lp) {
      actualTotalVt += Number(claim.amount) || 0;
      actualTotalAda += Number(claim.lovelace_amount) || 0;

      if (expectedClaimsByType.lp) {
        expectedTotalVt += expectedClaimsByType.lp.vtAmount;
        expectedTotalAda += expectedClaimsByType.lp.lovelaceAmount;

        const vtDiff = Math.abs((Number(claim.amount) || 0) - expectedClaimsByType.lp.vtAmount);
        const adaDiff = Math.abs((Number(claim.lovelace_amount) || 0) - expectedClaimsByType.lp.lovelaceAmount);

        maxVtRoundingError = Math.max(maxVtRoundingError, vtDiff);
        maxAdaRoundingError = Math.max(maxAdaRoundingError, adaDiff);

        if (vtDiff > 1 || adaDiff > 1) {
          discrepancies.push({
            claimId: claim.id,
            userId: claim.user_id,
            type: ClaimType.LP,
            actualAmount: Number(claim.amount) || 0,
            expectedAmount: expectedClaimsByType.lp.vtAmount,
            difference: (Number(claim.amount) || 0) - expectedClaimsByType.lp.vtAmount,
            percentageDifference:
              expectedClaimsByType.lp.vtAmount > 0
                ? (((Number(claim.amount) || 0) - expectedClaimsByType.lp.vtAmount) /
                    expectedClaimsByType.lp.vtAmount) *
                  100
                : 0,
            actualLovelaceAmount: Number(claim.lovelace_amount) || null,
            expectedLovelaceAmount: expectedClaimsByType.lp.lovelaceAmount,
            lovelaceDifference: (Number(claim.lovelace_amount) || 0) - expectedClaimsByType.lp.lovelaceAmount,
            details: {
              lpPercent: LP_PERCENT * 100,
              fdv,
            },
          });
        }
      } else {
        discrepancies.push({
          claimId: claim.id,
          userId: claim.user_id,
          type: ClaimType.LP,
          actualAmount: Number(claim.amount) || 0,
          expectedAmount: 0,
          difference: Number(claim.amount) || 0,
          percentageDifference: 100,
          details: {
            reason: 'LP claim exists in database but should not exist based on calculations',
          },
        });
      }
    }

    // Build context
    const context: VaultCalculationContext = {
      vaultId: vault.id,
      vaultName: vault.name,
      vaultStatus: vault.vault_status,
      totalAcquiredAda,
      totalContributedValueAda,
      vtSupply,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
      lpAdaAmount,
      lpVtAmount,
      vtPrice,
      fdv,
      acquisitionTransactions: acquisitionTransactions.length,
      contributionTransactions: contributionTransactions.length,
    };

    // Build summary
    const summary: ClaimVerificationSummary = {
      totalClaims: allClaims.length,
      validClaims: allClaims.length - discrepancies.length,
      claimsWithDiscrepancies: discrepancies.length,
      acquirerClaims: claimsByType.acquirer.length,
      contributorClaims: claimsByType.contributor.length,
      lpClaims: claimsByType.lp.length,
      actualTotalVtDistributed: actualTotalVt,
      expectedTotalVtDistributed: expectedTotalVt,
      vtDistributionDifference: actualTotalVt - expectedTotalVt,
      actualTotalAdaDistributed: actualTotalAda,
      expectedTotalAdaDistributed: expectedTotalAda,
      adaDistributionDifference: actualTotalAda - expectedTotalAda,
      maxVtRoundingError,
      maxAdaRoundingError,
    };

    // Build formulas explanation
    const formulas = {
      lpCalculation: {
        formula: 'LP = (LP_PERCENT × FDV) / 2  (split equally between ADA and VT)',
        steps: [
          '1. Calculate FDV (Fully Diluted Valuation):',
          '   - If acquirers exist: FDV = totalAcquiredAda / ASSETS_OFFERED_PERCENT',
          '   - If no acquirers: FDV = totalContributedValueAda',
          '2. LP ADA Amount = round((LP_PERCENT × FDV / 2) × 1,000,000) / 1,000,000',
          '3. LP VT Amount = round25((LP_PERCENT × vtSupply) / 2)',
          '4. VT Price = LP ADA Amount / LP VT Amount',
          '5. ADA Pair Multiplier = floor(LP VT Amount / (totalAcquiredAda × 1,000,000))',
          '6. Adjusted VT LP Amount = adaPairMultiplier × totalAcquiredAda × 1,000,000',
        ],
        roundingApplied: [
          'round25() - Rounds to 25 decimal places to prevent floating point errors',
          'Math.round() - Standard rounding for ADA amounts',
          'Math.floor() - Used for multiplier calculation to ensure integer values',
        ],
        intermediateValues: {
          fdv,
          lpAdaAmount,
          lpVtAmount,
          vtPrice,
          adjustedVtLpAmount,
        },
      },
      acquirerCalculation: {
        formula: 'VT = multiplier × adaSent × 1,000,000',
        steps: [
          '1. Calculate percentage of total acquire ADA:',
          '   percentOfTotal = round25(adaSent / totalAcquiredAda)',
          '2. Calculate VT received (before multiplier adjustment):',
          '   vtReceived = round25(percentOfTotal × ASSETS_OFFERED_PERCENT × (vtSupply - lpVtAmount))',
          '3. Calculate multiplier (integer for on-chain):',
          '   multiplier = floor(vtReceived / adaSent / 1,000,000)',
          '4. Adjust VT amount using multiplier:',
          '   finalVT = multiplier × adaSent × 1,000,000',
          '5. Apply minimum multiplier normalization:',
          '   minMultiplier = min(all acquirer multipliers)',
          '   normalizedVT = minMultiplier × adaSent × 1,000,000',
        ],
        roundingApplied: [
          'round25() - Applied twice: for percentage calculation and initial VT calculation',
          'Math.floor() - Used for multiplier to ensure integer value',
          'Multiplier normalization - All acquirers use the minimum multiplier for fairness',
        ],
        example:
          acquisitionTransactions.length > 0 && expectedClaimsByType.acquirer.length > 0
            ? {
                input: {
                  adaSent: acquisitionTransactions[0].amount || 0,
                  totalAcquiredAda,
                  lpVtAmount,
                  vtSupply,
                  ASSETS_OFFERED_PERCENT,
                },
                output: {
                  vtReceived: expectedClaimsByType.acquirer[0].vtAmount,
                  multiplier: expectedClaimsByType.acquirer[0].multiplier,
                },
              }
            : undefined,
      },
      contributorCalculation: {
        formula: 'VT = userTotalVtTokens × proportionOfUserTotal; ADA = userAdaShare × proportionOfUserTotal',
        steps: [
          '1. Calculate user proportion of this transaction:',
          '   proportionOfUserTotal = txContributedValue / userTotalValue',
          '2. Calculate contributor share of total:',
          '   contributorShare = userTotalValue / totalTvl',
          '3. Calculate VT tokens (if ASSETS_OFFERED_PERCENT < 100%):',
          '   userTotalVtTokens = round25((vtSupply - lpVtAmount) × (1 - ASSETS_OFFERED_PERCENT) × contributorShare)',
          '   vtAmount = floor(userTotalVtTokens × proportionOfUserTotal)',
          '4. Calculate ADA distribution:',
          '   adaForContributors = totalAcquiredAda - lpAdaAmount',
          '   userAdaShare = contributorShare × adaForContributors',
          '   adaAmount = floor(userAdaShare × proportionOfUserTotal × 1,000,000) lovelace',
          '5. Edge case: If ASSETS_OFFERED_PERCENT = 100%, vtAmount = 0 (contributors get only ADA)',
        ],
        roundingApplied: [
          'round25() - Applied to userTotalVtTokens calculation',
          'Math.floor() - Applied to final VT amount for this transaction',
          'Math.floor() - Applied to final lovelace amount',
          'Intermediate calculations may compound rounding from multiple transactions',
        ],
        example:
          contributionTransactions.length > 0 && expectedClaimsByType.contributor.length > 0
            ? {
                input: {
                  txContributedValue: contributionValueByTransaction[contributionTransactions[0].id] || 0,
                  userTotalValue: Object.values(userContributedValueMap)[0] || 0,
                  totalTvl: totalContributedValueAda,
                  lpVtAmount,
                  totalAcquiredAda,
                  lpAdaAmount,
                },
                output: {
                  vtAmount: expectedClaimsByType.contributor[0].vtAmount,
                  lovelaceAmount: expectedClaimsByType.contributor[0].lovelaceAmount,
                },
              }
            : undefined,
      },
      roundingMethods: {
        round25: 'Rounds to 25 decimal places: Math.round(value × 10^25) / 10^25',
        mathFloor: 'Always rounds down to nearest integer: Math.floor(value)',
        mathRound: 'Rounds to nearest integer: Math.round(value)',
      },
    };

    this.logger.log(
      `Claims verification complete for vault ${vaultId}: ` +
        `${discrepancies.length} discrepancies found out of ${allClaims.length} claims`
    );

    // Build per-user breakdown
    const userBreakdownMap = new Map<
      string,
      {
        userId: string;
        userAddress?: string;
        totalVtClaimed: number;
        totalAdaClaimed: number;
        contributionTransactions: number;
        acquisitionTransactions: number;
        totalContributed?: number;
        totalAcquired?: number;
        discrepancyCount: number;
        maxVtDiscrepancy: number;
        maxAdaDiscrepancy: number;
        tvlSharePercent?: number;
        expectedVtFromTvlShare?: number;
        claims: Array<{
          claimId: string;
          type: ClaimType;
          actualVt: number;
          expectedVt: number;
          actualAda: number;
          expectedAda: number;
          transactionId?: string;
        }>;
      }
    >();

    // Process all claims to build user breakdowns
    for (const claim of allClaims) {
      const userId = claim.user_id || claim.user?.id;
      if (!userId) continue;

      if (!userBreakdownMap.has(userId)) {
        userBreakdownMap.set(userId, {
          userId,
          userAddress: claim.user?.address,
          totalVtClaimed: 0,
          totalAdaClaimed: 0,
          contributionTransactions: 0,
          acquisitionTransactions: 0,
          totalContributed: 0,
          totalAcquired: 0,
          discrepancyCount: 0,
          maxVtDiscrepancy: 0,
          maxAdaDiscrepancy: 0,
          claims: [],
        });
      }

      const userBreakdown = userBreakdownMap.get(userId);
      const actualVt = Number(claim.amount) || 0;
      const actualAda = Number(claim.lovelace_amount) || 0;

      // Get expected amounts
      const expected = claim.transaction?.id ? expectedClaims.get(claim.transaction.id) : null;
      const expectedVt = claim.type === ClaimType.LP ? expectedClaimsByType.lp?.vtAmount || 0 : expected?.vtAmount || 0;
      const expectedAda =
        claim.type === ClaimType.LP ? expectedClaimsByType.lp?.lovelaceAmount || 0 : expected?.lovelaceAmount || 0;

      // Update totals
      userBreakdown.totalVtClaimed += actualVt;
      userBreakdown.totalAdaClaimed += actualAda;

      // Update transaction counts and amounts
      if (claim.type === ClaimType.CONTRIBUTOR) {
        userBreakdown.contributionTransactions++;
        if (claim.transaction?.id) {
          userBreakdown.totalContributed += contributionValueByTransaction[claim.transaction.id] || 0;
        }
      } else if (claim.type === ClaimType.ACQUIRER) {
        userBreakdown.acquisitionTransactions++;
        userBreakdown.totalAcquired += claim.transaction?.amount || 0;
      }

      // Check for discrepancies
      const vtDiff = Math.abs(actualVt - expectedVt);
      const adaDiff = Math.abs(actualAda - expectedAda);

      if (vtDiff > 1 || adaDiff > 1) {
        userBreakdown.discrepancyCount++;
        userBreakdown.maxVtDiscrepancy = Math.max(userBreakdown.maxVtDiscrepancy, vtDiff);
        userBreakdown.maxAdaDiscrepancy = Math.max(userBreakdown.maxAdaDiscrepancy, adaDiff);
      }

      // Add claim details
      userBreakdown.claims.push({
        claimId: claim.id,
        type: claim.type,
        actualVt,
        expectedVt,
        actualAda,
        expectedAda,
        transactionId: claim.transaction?.id,
      });
    }

    // Calculate TVL share percentage for contributors
    for (const breakdown of userBreakdownMap.values()) {
      if (breakdown.contributionTransactions > 0 && totalContributedValueAda > 0) {
        breakdown.tvlSharePercent = (breakdown.totalContributed / totalContributedValueAda) * 100;

        // Calculate expected VT from simple TVL share (for comparison with actual formula)
        const vtForContributors = (vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT);
        breakdown.expectedVtFromTvlShare = Math.floor(
          (breakdown.totalContributed / totalContributedValueAda) * vtForContributors
        );
      }
    }

    // Convert map to array, sorted by total VT claimed (descending)
    let userBreakdowns = Array.from(userBreakdownMap.values()).sort((a, b) => b.totalVtClaimed - a.totalVtClaimed);

    // Apply filters if provided
    if (query?.userAddress) {
      const searchAddress = query.userAddress.toLowerCase();
      userBreakdowns = userBreakdowns.filter(
        user => user.userAddress && user.userAddress.toLowerCase().includes(searchAddress)
      );
    }

    if (query?.userId) {
      userBreakdowns = userBreakdowns.filter(user => user.userId === query.userId);
    }

    // Filter discrepancies to match filtered users
    let filteredDiscrepancies = discrepancies;
    if (query?.userAddress || query?.userId) {
      const filteredUserIds = new Set(userBreakdowns.map(u => u.userId));
      filteredDiscrepancies = discrepancies.filter(d => filteredUserIds.has(d.userId));
    }

    return {
      success: true,
      message:
        filteredDiscrepancies.length === 0
          ? 'All claims match expected calculations'
          : `Found ${filteredDiscrepancies.length} claim(s) with discrepancies${query?.userAddress || query?.userId ? ' (filtered)' : ''}`,
      context,
      formulas,
      summary,
      discrepancies: filteredDiscrepancies,
      userBreakdowns,
      verifiedAt: new Date(),
    };
  }
}
