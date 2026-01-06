import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { TransactionsService } from '../processing-tx/offchain-tx/transactions.service';

import { ClaimsService } from './claims.service';

import { Claim } from '@/database/claim.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

interface VaultMonthlyAllocation {
  vaultId: string;
  vaultTVL: number;
  monthlyL4VA: number; // This month's allocation
  creatorAmount: number; // 20%
  holdersAmount: number; // 80%
  monthNumber: number; // Which month of vesting (0-11)
}

interface VTHolder {
  address: string;
  balance: string;
  percentage: number;
}

/**
 * L4VA Rewards Service
 *
 * Distributes L4VA tokens monthly to vault participants based on pro-rata TVL share.
 *
 * Key Principles:
 * - Monthly Budget: 3,333,333 L4VA (200M total / 60 months)
 * - Rolling 30-day window: Only vaults locked in past 30 days receive rewards
 * - Pro-rata allocation: Each vault gets TVL / Total30DayTVL × Monthly Budget
 * - Split: 20% to creator (AU), 80% to VT holders (ACs/VIs)
 * - Vesting: 12 months from lock date
 * - Termination: Unvested rewards cancelled if vault terminates early
 */
@Injectable()
export class L4vaRewardsService {
  private readonly logger = new Logger(L4vaRewardsService.name);

  private readonly L4VA_POLICY_ID: string;
  private readonly L4VA_ASSET_NAME: string;
  private readonly L4VA_DECIMALS: number;
  private readonly L4VA_MONTHLY_BUDGET: number; // 3,333,333 with decimals

  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly adminSKey: string;

  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly claimsService: ClaimsService,
    private readonly transactionsService: TransactionsService
  ) {
    // L4VA Token Config
    this.L4VA_POLICY_ID = this.configService.get<string>('L4VA_POLICY_ID');
    this.L4VA_ASSET_NAME = this.configService.get<string>('L4VA_ASSET_NAME');
    this.L4VA_DECIMALS = this.configService.get<number>('L4VA_DECIMALS') || 3;
    this.L4VA_MONTHLY_BUDGET = this.configService.get<number>('L4VA_MONTHLY_BUDGET');

    // Admin Config (L4VA tokens distributed from admin wallet)
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');

    // General Config
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Monthly cron job to create L4VA claims
   * Runs on the 1st of every month at midnight
   *
   * Algorithm:
   * 1. Find all vaults locked in past 30 days
   * 2. Calculate total TVL of those vaults
   * 3. Allocate 3,333,333 L4VA proportionally
   * 4. For each vault, check which month of vesting (0-11)
   * 5. Create claims: 20% to creator, 80% split by VT holdings
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async createMonthlyL4VARewards(): Promise<void> {
    this.logger.log('Running monthly L4VA rewards distribution...');

    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Get all vaults locked in past 30 days
      const recentlyLockedVaults: Pick<Vault, 'id' | 'governance_phase_start' | 'total_assets_cost_ada'>[] =
        await this.vaultRepository.find({
          where: {
            vault_status: VaultStatus.locked,
            governance_phase_start: Between(thirtyDaysAgo, now),
          },
          select: ['id', 'governance_phase_start', 'total_assets_cost_ada'],
          relations: ['owner'],
        });

      if (recentlyLockedVaults.length === 0) {
        this.logger.log('No vaults locked in past 30 days');
        return;
      }

      // Calculate total TVL of vaults locked in past 30 days
      const totalTVL = recentlyLockedVaults.reduce((sum, v) => sum + (v.total_assets_cost_ada || 0), 0);

      if (totalTVL === 0) {
        this.logger.warn('Total TVL is 0 for vaults locked in past 30 days');
        return;
      }

      this.logger.log(
        `Found ${recentlyLockedVaults.length} vaults locked in past 30 days. ` +
          `Total TVL: ${totalTVL} ADA. Monthly budget: ${this.L4VA_MONTHLY_BUDGET / 10 ** this.L4VA_DECIMALS} L4VA`
      );

      // Calculate allocation for each vault
      const allocations: VaultMonthlyAllocation[] = [];

      for (const vault of recentlyLockedVaults) {
        // Determine which month of vesting this is (0-11)
        const lockDate = new Date(vault.governance_phase_start);
        const monthsSinceLock = this.getMonthsSince(lockDate, now);

        // Stop after 12 months
        if (monthsSinceLock >= 12) {
          continue;
        }

        // Check if it's actually time to create this month's claims
        const nextClaimDate = new Date(lockDate);
        nextClaimDate.setMonth(nextClaimDate.getMonth() + monthsSinceLock);

        // Only create claims if we've passed the next claim date
        if (now < nextClaimDate) {
          this.logger.log(
            `Vault ${vault.id} month ${monthsSinceLock + 1} not due yet. ` +
              `Next claim date: ${nextClaimDate.toISOString()}`
          );
          continue;
        }

        // Check if this month's claims already exist
        const existingClaims = await this.claimRepository.count({
          where: {
            vault: { id: vault.id },
            type: ClaimType.L4VA,
            metadata: { month: monthsSinceLock + 1 } as any,
          },
        });

        if (existingClaims > 0) {
          this.logger.log(`Month ${monthsSinceLock + 1} claims already exist for vault ${vault.id}, skipping`);
          continue;
        }

        // Calculate pro-rata share
        const vaultTVL = vault.total_assets_cost_ada || 0;
        const monthlyL4VA = Math.floor((vaultTVL / totalTVL) * this.L4VA_MONTHLY_BUDGET);

        allocations.push({
          vaultId: vault.id,
          vaultTVL,
          monthlyL4VA,
          creatorAmount: Math.floor(monthlyL4VA * 0.2), // 20% to creator
          holdersAmount: Math.floor(monthlyL4VA * 0.8), // 80% to VT holders
          monthNumber: monthsSinceLock,
        });
      }

      if (allocations.length === 0) {
        this.logger.log('No vaults due for L4VA claims this period');
        return;
      }

      // Create claims for each vault
      for (const allocation of allocations) {
        try {
          await this.createMonthlyL4VAClaims(allocation);
        } catch (error) {
          this.logger.error(`Failed to create L4VA claims for vault ${allocation.vaultId}:`, error);
        }
      }

      this.logger.log(`Monthly L4VA rewards distribution completed. Created claims for ${allocations.length} vaults`);
    } catch (error) {
      this.logger.error('Failed to run monthly L4VA rewards distribution:', error);
      throw error;
    }
  }

  /**
   * Create L4VA claims for a specific vault for this month
   */
  private async createMonthlyL4VAClaims(allocation: VaultMonthlyAllocation): Promise<void> {
    const { vaultId, creatorAmount, holdersAmount, monthNumber } = allocation;

    this.logger.log(
      `Creating month ${monthNumber + 1}/12 L4VA claims for vault ${vaultId}: ` +
        `${allocation.monthlyL4VA / 10 ** this.L4VA_DECIMALS} L4VA total`
    );

    // Check if claims for this month already exist
    const existingClaims = await this.claimRepository.count({
      where: {
        vault: { id: vaultId },
        type: ClaimType.L4VA,
        metadata: { month: monthNumber + 1 } as any,
      },
    });

    if (existingClaims > 0) {
      this.logger.log(`Claims for month ${monthNumber + 1} already exist for vault ${vaultId}, skipping`);
      return;
    }

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['owner'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Get latest snapshot for current VT distribution
    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { vault: { id: vaultId } },
      order: { createdAt: 'DESC' },
    });

    if (!latestSnapshot) {
      this.logger.warn(`No snapshot found for vault ${vaultId}, distribution may not be finalized yet. Skipping.`);
      return;
    }

    const claims: Partial<Claim>[] = [];

    // 1. Create claim for vault creator (20%)
    claims.push({
      user: { id: vault.owner.id } as any,
      vault: { id: vaultId } as any,
      type: ClaimType.L4VA,
      amount: creatorAmount,
      status: ClaimStatus.PENDING,
      metadata: {
        l4va_role: 'AU',
        month: monthNumber + 1,
        snapshot_id: latestSnapshot.id,
      },
    });

    // 2. Create claims for VT holders (80%, split by holdings)
    const vtHolders = this.parseVTHolders(latestSnapshot.addressBalances);

    for (const holder of vtHolders) {
      const holderAmount = Math.floor(holdersAmount * holder.percentage);

      if (holderAmount === 0) continue; // Skip dust amounts

      // Find user by address
      const user = await this.userRepository.findOne({
        where: { address: holder.address },
        select: ['id'],
      });

      // Skip if user doesn't exist
      if (!user) {
        this.logger.warn(`Skipping L4VA claim for address ${holder.address} - user account not found`);
        continue;
      }

      claims.push({
        user: { id: user.id } as any,
        vault: { id: vaultId } as any,
        type: ClaimType.L4VA,
        amount: holderAmount,
        status: ClaimStatus.PENDING,
        metadata: {
          l4va_role: 'AC/VI',
          month: monthNumber + 1,
          snapshot_id: latestSnapshot.id,
        },
      });
    }

    // Save all claims
    if (claims.length > 0) {
      await this.claimRepository.save(claims);
      this.logger.log(`✅ Created ${claims.length} L4VA claims for vault ${vaultId} month ${monthNumber + 1}`);
    }
  }

  /**
   * Calculate months between two dates
   */
  private getMonthsSince(startDate: Date, endDate: Date): number {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const yearsDiff = end.getFullYear() - start.getFullYear();
    const monthsDiff = end.getMonth() - start.getMonth();

    return yearsDiff * 12 + monthsDiff;
  }

  /**
   * Parse VT holders from snapshot address balances
   */
  private parseVTHolders(addressBalances: Record<string, string>): VTHolder[] {
    const totalSupply = Object.values(addressBalances).reduce((sum, balance) => sum + BigInt(balance), BigInt(0));

    if (totalSupply === BigInt(0)) {
      return [];
    }

    return Object.entries(addressBalances)
      .filter(([_, balance]) => BigInt(balance) > BigInt(0))
      .map(([address, balance]) => {
        const balanceBigInt = BigInt(balance);
        const percentageBigInt = (balanceBigInt * BigInt(10000)) / totalSupply;

        return {
          address,
          balance,
          percentage: Number(percentageBigInt) / 10000,
        };
      })
      .filter(holder => holder.percentage > 0);
  }

  /**
   * Build batch L4VA claim transaction (returns presigned tx for user to sign)
   * Allows user to claim multiple L4VA rewards in single transaction
   */
  async buildBatchL4VAClaimTransaction(
    userId: string,
    claimIds: string[]
  ): Promise<{
    transactionId: string;
    presignedTx: string;
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
      relations: ['user', 'vault'],
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
      requiredSigners: [this.adminHash],
      network: this.isMainnet ? ('mainnet' as const) : ('preprod' as const),
    };

    try {
      const buildResponse = await this.blockchainService.buildTransaction(input);
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      // Create internal transaction record
      const transaction = await this.transactionsService.createTransaction({
        vault_id: claims[0].vault.id,
        userId: userId,
        type: TransactionType.claim,
        assets: [],
        metadata: {
          claimIds,
          totalL4VA,
          claimsCount: claims.length,
          isL4VA: true,
        },
      });

      this.logger.log(
        `✅ Built L4VA claim transaction ${transaction.id} for ${totalL4VA / 10 ** this.L4VA_DECIMALS} L4VA`
      );

      return {
        transactionId: transaction.id,
        presignedTx: txToSubmitOnChain.to_hex(),
        totalL4VAClaimed: totalL4VA,
        claimedCount: claims.length,
      };
    } catch (error) {
      this.logger.error('Failed to build L4VA claim transaction:', error);
      throw error;
    }
  }

  async submitSignedTransaction(
    transactionId: string,
    claimIds: string[],
    signedTxHex: string
  ): Promise<{
    success: boolean;
    transactionId: string;
    blockchainTxHash: string;
  }> {
    const internalTxExists = await this.transactionRepository.exists({
      where: { id: transactionId },
    });

    if (!internalTxExists) {
      throw new NotFoundException('Transaction not found');
    }

    try {
      // Submit to blockchain
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTxHex,
        signatures: [],
      });

      await this.transactionsService.updateTransactionHash(transactionId, submitResponse.txHash);
      await this.claimsService.updateClaimStatus(claimIds, ClaimStatus.CLAIMED);

      return {
        success: true,
        transactionId: transactionId,
        blockchainTxHash: submitResponse.txHash,
      };
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transactionId, TransactionStatus.failed);
      throw error;
    }
  }

  /**
   * Claim all available L4VA rewards for a user
   */
  async claimAllAvailableL4VA(userId: string): Promise<{
    transactionId: string;
    presignedTx: string;
    totalL4VAClaimed: number;
    claimedCount: number;
  }> {
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
   * Handle vault termination - cancel remaining L4VA claims
   */
  async handleVaultTermination(vaultId: string): Promise<void> {
    this.logger.log(`Handling vault termination for ${vaultId} - cancelling unvested L4VA rewards`);

    try {
      // Cancel all PENDING L4VA claims for this vault
      const result = await this.claimRepository.update(
        {
          vault: { id: vaultId },
          type: ClaimType.L4VA,
          status: ClaimStatus.PENDING,
        },
        {
          status: ClaimStatus.FAILED,
          description: 'Vault terminated - unvested rewards cancelled',
          updated_at: new Date(),
        }
      );

      this.logger.log(`✅ Cancelled ${result.affected} unvested L4VA claims for terminated vault ${vaultId}`);
    } catch (error) {
      this.logger.error(`Failed to handle vault termination for ${vaultId}:`, error);
      throw error;
    }
  }
}
