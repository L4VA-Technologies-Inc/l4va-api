import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, Repository } from 'typeorm';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

interface CreateL4VARewardsParams {
  vault: Vault;
  contributorClaims: Claim[];
  acquirerClaims: Claim[];
  totalTVL: number; // in ADA
}

interface L4VAAllocation {
  totalAllocation: number; // Total L4VA over 12 months
  monthlyAmount: number; // L4VA per month
  auAllocation: number; // 20% to vault creator
  acAllocation: number; // 80% * AC percentage
  viAllocation: number; // 80% * VI percentage
  acPercentage: number; // Percentage allocated to Asset Contributors
}

@Injectable()
export class L4vaRewardsService {
  private readonly logger = new Logger(L4vaRewardsService.name);

  // L4VA Token Configuration
  private readonly L4VA_POLICY_ID: string;
  private readonly L4VA_ASSET_NAME: string;
  private readonly L4VA_DECIMALS: number;
  private readonly L4VA_MONTHLY_BUDGET: number; // 3,333,333 with decimals

  // Admin wallet (holds L4VA tokens for distribution)
  private readonly adminAddress: string;
  private readonly adminSKey: string;

  // General config
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService
  ) {
    // L4VA Token Config
    this.L4VA_POLICY_ID = this.configService.get<string>('L4VA_POLICY_ID');
    this.L4VA_ASSET_NAME = this.configService.get<string>('L4VA_ASSET_NAME');
    this.L4VA_DECIMALS = this.configService.get<number>('L4VA_DECIMALS') || 3;
    this.L4VA_MONTHLY_BUDGET = this.configService.get<number>('L4VA_MONTHLY_BUDGET');

    // Admin Config (L4VA tokens distributed from admin wallet)
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');

    // General Config
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Create L4VA reward claims when vault locks successfully
   * Creates 12 monthly claims for each participant (AU, AC, VI)
   */
  async createL4VARewardsClaims(params: CreateL4VARewardsParams): Promise<void> {
    const { vault, contributorClaims, acquirerClaims, totalTVL } = params;

    this.logger.log(`Creating L4VA reward claims for vault ${vault.id}`);

    // Calculate vault's share of monthly L4VA allocation
    const allocation = await this.calculateVaultL4VAAllocation(vault.id, vault.governance_phase_start);

    if (!allocation || allocation.totalAllocation === 0) {
      this.logger.warn(`No L4VA allocation calculated for vault ${vault.id}`);
      return;
    }

    this.logger.log(
      `Vault ${vault.id} L4VA allocation: ${allocation.totalAllocation / 10 ** this.L4VA_DECIMALS} L4VA ` +
        `(${allocation.monthlyAmount / 10 ** this.L4VA_DECIMALS} per month over 12 months)`
    );

    const l4vaClaims: Partial<Claim>[] = [];

    // 1. Create claims for Vault Creator (AU) - 20% of total
    if (vault.owner.id) {
      const auMonthlyAmount = Math.floor(allocation.auAllocation / 12);

      for (let month = 0; month < 12; month++) {
        const claimDate = new Date(vault.governance_phase_start);
        claimDate.setMonth(claimDate.getMonth() + month);

        l4vaClaims.push({
          user: { id: vault.owner.id } as any,
          vault: { id: vault.id } as any,
          type: ClaimType.L4VA,
          amount: auMonthlyAmount,
          status: month === 0 ? ClaimStatus.AVAILABLE : ClaimStatus.PENDING,
          created_at: claimDate,
          description: `L4VA Rewards - Month ${month + 1}/12 (Vault Creator)`,
          metadata: {
            l4va_role: 'AU',
            month: month + 1,
            totalAllocation: allocation.auAllocation,
            vaultTVL: totalTVL,
          },
        });
      }

      this.logger.log(`Created 12 AU claims for vault creator ${vault.owner.id}`);
    }

    // 2. Create claims for Asset Contributors (AC)
    if (contributorClaims.length > 0 && allocation.acAllocation > 0) {
      // Calculate each contributor's share based on their VT tokens
      const totalContributorVT = contributorClaims.reduce((sum, claim) => sum + Number(claim.amount), 0);

      for (const contributorClaim of contributorClaims) {
        const contributorShare = Number(contributorClaim.amount) / totalContributorVT;
        const contributorTotalL4VA = Math.floor(allocation.acAllocation * contributorShare);
        const monthlyAmount = Math.floor(contributorTotalL4VA / 12);

        if (monthlyAmount === 0) continue; // Skip if amount too small

        for (let month = 0; month < 12; month++) {
          const claimDate = new Date(vault.governance_phase_start);
          claimDate.setMonth(claimDate.getMonth() + month);

          l4vaClaims.push({
            user: { id: contributorClaim.user_id } as any,
            vault: { id: vault.id } as any,
            type: ClaimType.L4VA,
            amount: monthlyAmount,
            status: month === 0 ? ClaimStatus.AVAILABLE : ClaimStatus.PENDING,
            created_at: claimDate,
            description: `L4VA Rewards - Month ${month + 1}/12 (Asset Contributor)`,
            metadata: {
              l4va_role: 'AC',
              month: month + 1,
              totalAllocation: contributorTotalL4VA,
              vtShare: contributorShare,
              contributorClaimId: contributorClaim.id,
            },
          });
        }
      }

      this.logger.log(`Created AC claims for ${contributorClaims.length} contributors`);
    }

    // 3. Create claims for Vault Investors (VI)
    if (acquirerClaims.length > 0 && allocation.viAllocation > 0) {
      // Calculate each investor's share based on their VT tokens
      const totalAcquirerVT = acquirerClaims.reduce((sum, claim) => sum + Number(claim.amount), 0);

      for (const acquirerClaim of acquirerClaims) {
        const investorShare = Number(acquirerClaim.amount) / totalAcquirerVT;
        const investorTotalL4VA = Math.floor(allocation.viAllocation * investorShare);
        const monthlyAmount = Math.floor(investorTotalL4VA / 12);

        if (monthlyAmount === 0) continue; // Skip if amount too small

        for (let month = 0; month < 12; month++) {
          const claimDate = new Date(vault.governance_phase_start);
          claimDate.setMonth(claimDate.getMonth() + month);

          l4vaClaims.push({
            user: { id: acquirerClaim.user_id } as any,
            vault: { id: vault.id } as any,
            type: ClaimType.L4VA,
            amount: monthlyAmount,
            status: month === 0 ? ClaimStatus.AVAILABLE : ClaimStatus.PENDING,
            created_at: claimDate,
            description: `L4VA Rewards - Month ${month + 1}/12 (Vault Investor)`,
            metadata: {
              l4va_role: 'VI',
              month: month + 1,
              totalAllocation: investorTotalL4VA,
              vtShare: investorShare,
              acquirerClaimId: acquirerClaim.id,
            },
          });
        }
      }

      this.logger.log(`Created VI claims for ${acquirerClaims.length} investors`);
    }

    // Save all L4VA claims
    if (l4vaClaims.length > 0) {
      await this.claimRepository.save(l4vaClaims);
      this.logger.log(`✅ Created ${l4vaClaims.length} L4VA reward claims for vault ${vault.id}`);
    } else {
      this.logger.warn(`No L4VA claims created for vault ${vault.id}`);
    }
  }

  /**
   * Monthly cron job to activate next month's L4VA rewards
   * Runs on the 1st of every month at midnight
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async activateMonthlyRewards(): Promise<void> {
    this.logger.log('🔄 Running monthly L4VA rewards activation...');

    try {
      const now = new Date();

      // Find all PENDING L4VA claims where created_at <= now
      const pendingClaims = await this.claimRepository.find({
        where: {
          type: ClaimType.L4VA,
          status: ClaimStatus.PENDING,
          created_at: LessThanOrEqual(now),
        },
      });

      if (pendingClaims.length === 0) {
        this.logger.log('No pending L4VA claims to activate this month');
        return;
      }

      // Update all eligible claims to AVAILABLE
      await this.claimRepository.update(
        {
          id: In(pendingClaims.map(c => c.id)),
        },
        {
          status: ClaimStatus.AVAILABLE,
          updated_at: now,
        }
      );

      this.logger.log(`✅ Activated ${pendingClaims.length} L4VA reward claims for this month`);
    } catch (error) {
      this.logger.error('Failed to activate monthly L4VA rewards:', error);
      throw error;
    }
  }

  /**
   * Build and submit batch L4VA claim transaction
   * Allows user to claim multiple L4VA rewards in single transaction
   */
  async buildBatchL4VAClaimTransaction(
    userId: string,
    claimIds: string[]
  ): Promise<{
    txHash: string;
    totalL4VAClaimed: number;
    claimedCount: number;
  }> {
    if (claimIds.length === 0) {
      throw new BadRequestException('Must provide at least 1 claim ID');
    }

    this.logger.log(`Building batch L4VA claim for user ${userId}: ${claimIds.length} claims`);

    // Fetch claims
    const claims = await this.claimRepository.find({
      where: {
        id: In(claimIds),
        user: { id: userId },
        type: ClaimType.L4VA,
        status: ClaimStatus.AVAILABLE,
      },
      relations: ['user'],
    });

    if (claims.length === 0) {
      throw new NotFoundException('No available L4VA claims found');
    }

    if (claims.length !== claimIds.length) {
      throw new BadRequestException(
        `Found ${claims.length} claims, but ${claimIds.length} were requested. ` +
          `Some claims may be already claimed or not available.`
      );
    }

    // Calculate total L4VA amount
    const totalL4VA = claims.reduce((sum, claim) => sum + Number(claim.amount), 0);
    const userAddress = claims[0].user.address;

    this.logger.log(`Total L4VA to claim: ${totalL4VA / 10 ** this.L4VA_DECIMALS} L4VA`);

    // Get admin wallet UTXOs with L4VA tokens
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      targetAssets: [{ token: `${this.L4VA_POLICY_ID}${this.L4VA_ASSET_NAME}`, amount: totalL4VA }],
      minAda: 2000000,
    });

    if (adminUtxos.length === 0) {
      throw new BadRequestException('No UTXOs with L4VA tokens found in admin wallet');
    }

    // Build transaction
    const input = {
      changeAddress: this.adminAddress,
      message: `L4VA Rewards Claim - ${claims.length} claims`,
      utxos: adminUtxos,
      outputs: [
        {
          address: userAddress,
          assets: [
            {
              policyId: this.L4VA_POLICY_ID,
              assetName: { name: this.L4VA_ASSET_NAME, format: 'hex' as const },
              quantity: totalL4VA,
            },
          ],
        },
      ],
      network: this.isMainnet ? ('mainnet' as const) : ('preprod' as const),
    };

    try {
      const buildResponse = await this.blockchainService.buildTransaction(input);

      // Sign with admin key
      const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      // Submit transaction
      const response = await this.blockchainService.submitTransaction({
        transaction: txToSubmit.to_hex(),
      });

      if (!response.txHash) {
        throw new Error('Transaction submission failed - no txHash returned');
      }

      // Create transaction records
      await Promise.all(
        claims.map(claim =>
          this.transactionRepository.save({
            user_id: userId,
            vault_id: claim.vault.id,
            type: TransactionType.claim,
            status: TransactionStatus.confirmed,
            tx_hash: response.txHash,
            amount: claim.amount,
          })
        )
      );

      // Mark claims as CLAIMED
      await this.claimRepository.update(
        { id: In(claimIds) },
        {
          status: ClaimStatus.CLAIMED,
          metadata: claims.map(c => ({
            ...c.metadata,
            claimedAt: new Date(),
            txHash: response.txHash,
          })) as any,
        }
      );

      this.logger.log(`✅ Successfully claimed ${totalL4VA / 10 ** this.L4VA_DECIMALS} L4VA in tx ${response.txHash}`);

      return {
        txHash: response.txHash,
        totalL4VAClaimed: totalL4VA,
        claimedCount: claims.length,
      };
    } catch (error) {
      this.logger.error('Failed to build/submit L4VA claim transaction:', error);
      throw error;
    }
  }

  /**
   * Claim all available L4VA rewards for a user
   */
  async claimAllAvailableL4VA(userId: string): Promise<{
    txHash: string;
    totalL4VAClaimed: number;
    claimedCount: number;
  }> {
    // Find all available L4VA claims for user
    const availableClaims = await this.claimRepository.find({
      where: {
        user: { id: userId },
        type: ClaimType.L4VA,
        status: ClaimStatus.AVAILABLE,
      },
      select: ['id'],
    });

    if (availableClaims.length === 0) {
      throw new NotFoundException('No available L4VA claims found for this user');
    }

    const claimIds = availableClaims.map(c => c.id);
    return this.buildBatchL4VAClaimTransaction(userId, claimIds);
  }

  /**
   * Calculate vault's L4VA allocation based on TVL share
   */
  async calculateVaultL4VAAllocation(vaultId: string, lockDate: Date): Promise<L4VAAllocation | null> {
    try {
      // Get vault TVL
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'total_assets_cost_ada', 'tokens_for_acquires'],
      });

      if (!vault || !vault.total_assets_cost_ada) {
        this.logger.warn(`Vault ${vaultId} not found or has no TVL`);
        return null;
      }

      const vaultTVL = vault.total_assets_cost_ada;

      // Get TVL of all vaults locked in same 30-day window
      const windowStart = new Date(lockDate);
      windowStart.setDate(windowStart.getDate() - 30);

      const vaultsInWindow = await this.vaultRepository.find({
        where: {
          vault_status: VaultStatus.locked,
          governance_phase_start: Between(windowStart, lockDate),
        },
        select: ['id', 'total_assets_cost_ada'],
      });

      const totalWindowTVL = vaultsInWindow.reduce((sum, v) => sum + (v.total_assets_cost_ada || 0), 0);

      if (totalWindowTVL === 0) {
        this.logger.warn('Total TVL in 30-day window is 0');
        return null;
      }

      // Calculate vault's share of monthly budget
      const vaultShare = vaultTVL / totalWindowTVL;
      const totalAllocation = Math.floor(this.L4VA_MONTHLY_BUDGET * vaultShare);
      const monthlyAmount = Math.floor(totalAllocation / 12);

      // Split allocation: 20% AU, 80% split between AC/VI based on tokens_for_acquirers
      const auAllocation = Math.floor(totalAllocation * 0.2);
      const remaining = totalAllocation - auAllocation;

      // tokens_for_acquirers is percentage (0-100)
      const viPercentage = (vault.tokens_for_acquires || 0) / 100;
      const acPercentage = 1 - viPercentage;

      const viAllocation = Math.floor(remaining * viPercentage);
      const acAllocation = remaining - viAllocation;

      return {
        totalAllocation,
        monthlyAmount,
        auAllocation,
        acAllocation,
        viAllocation,
        acPercentage,
      };
    } catch (error) {
      this.logger.error(`Error calculating L4VA allocation for vault ${vaultId}:`, error);
      return null;
    }
  }

  /**
   * Get vault's TVL share in 30-day window
   */
  async getVaultTVLShare(vaultId: string, lockDate: Date): Promise<number> {
    const allocation = await this.calculateVaultL4VAAllocation(vaultId, lockDate);
    if (!allocation) return 0;

    return allocation.totalAllocation / this.L4VA_MONTHLY_BUDGET;
  }
}
