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

interface CreateL4VARewardsParams {
  vaultId: string;
  governancePhaseStart: Date;
  totalTVL: number; // in ADA
  snapshotId: string; // Snapshot taken at lock time
}

interface L4VAAllocation {
  totalAllocation: number; // Total L4VA over 12 months
  monthlyAmount: number; // L4VA per month
  creatorAllocation: number; // 20% to vault creator
  holdersAllocation: number; // 80% split by VT holders
}

interface VTHolder {
  address: string;
  balance: string;
  percentage: number;
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
  private readonly adminHash: string;
  private readonly adminSKey: string;

  // General config
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
   * Initialize L4VA rewards tracking for a vault
   * Called when vault locks - stores initial snapshot and allocation info
   */
  async initializeL4VARewards(params: CreateL4VARewardsParams): Promise<void> {
    const { vaultId, governancePhaseStart, totalTVL, snapshotId } = params;

    this.logger.log(`Initializing L4VA rewards for vault ${vaultId}`);

    // Calculate vault's L4VA allocation
    const allocation = await this.calculateVaultL4VAAllocation(vaultId, governancePhaseStart, totalTVL);

    if (!allocation || allocation.totalAllocation === 0) {
      this.logger.warn(`No L4VA allocation calculated for vault ${vaultId}`);
      return;
    }

    this.logger.log(
      `Vault ${vaultId} L4VA allocation: ${allocation.totalAllocation / 10 ** this.L4VA_DECIMALS} L4VA ` +
        `(${allocation.monthlyAmount / 10 ** this.L4VA_DECIMALS} per month over 12 months)`
    );

    // Create first month claims immediately (allocation info stored in claim metadata)
    await this.createMonthlyL4VAClaims(vaultId, 0, allocation, snapshotId);

    this.logger.log(`✅ Initialized L4VA rewards for vault ${vaultId}`);
  }

  /**
   * Monthly cron job to create new L4VA claims based on current VT holdings
   * Runs on the 1st of every month at midnight
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async createMonthlyL4VARewards(): Promise<void> {
    this.logger.log('🔄 Running monthly L4VA rewards distribution...');

    try {
      // Find all locked vaults
      const lockedVaults = await this.vaultRepository.find({
        where: { vault_status: VaultStatus.locked },
        select: ['id', 'governance_phase_start', 'total_assets_cost_ada', 'tokens_for_acquires'],
      });

      this.logger.log(`Checking ${lockedVaults.length} locked vaults for L4VA distribution`);

      for (const vault of lockedVaults) {
        try {
          // Count existing L4VA claims for this vault
          const existingClaims = await this.claimRepository.find({
            where: {
              vault: { id: vault.id },
              type: ClaimType.L4VA,
            },
            select: ['id', 'metadata'],
            order: { created_at: 'ASC' },
          });

          if (existingClaims.length === 0) {
            continue; // No claims yet, vault not initialized
          }

          // Determine which month this is based on unique month numbers in claims
          const existingMonths = new Set(existingClaims.map(c => c.metadata?.month).filter(Boolean));
          const monthsDistributed = existingMonths.size;

          // Check if all 12 months distributed
          if (monthsDistributed >= 12) {
            continue; // All months complete
          }

          // Check if it's time for next month
          const vestingStartDate = new Date(vault.governance_phase_start);
          const expectedMonth = new Date(vestingStartDate);
          expectedMonth.setMonth(expectedMonth.getMonth() + monthsDistributed + 1);

          const now = new Date();
          if (now < expectedMonth) {
            continue; // Not time yet
          }

          // Get allocation from first month claims metadata
          const firstClaim = existingClaims.find(c => c.metadata?.month === 1);

          if (!firstClaim?.metadata?.allocation) {
            this.logger.warn(`No allocation metadata found for vault ${vault.id}`);
            continue;
          }

          const allocation = firstClaim.metadata.allocation as L4VAAllocation;
          const snapshotId = firstClaim.metadata.snapshot_id;

          // Create next month's claims
          await this.createMonthlyL4VAClaims(vault.id, monthsDistributed + 1, allocation, snapshotId);
        } catch (error) {
          this.logger.error(`Failed to create L4VA claims for vault ${vault.id}:`, error);
        }
      }

      this.logger.log('✅ Monthly L4VA rewards distribution completed');
    } catch (error) {
      this.logger.error('Failed to run monthly L4VA rewards distribution:', error);
      throw error;
    }
  }

  /**
   * Create L4VA claims for a specific month based on current snapshot
   */
  private async createMonthlyL4VAClaims(
    vaultId: string,
    monthNumber: number,
    allocation: L4VAAllocation,
    lockSnapshotId: string
  ): Promise<void> {
    this.logger.log(`Creating month ${monthNumber + 1} L4VA claims for vault ${vaultId}`);

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['owner'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Get latest snapshot for current VT distribution
    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { assetId: vault.asset_vault_name },
      order: { createdAt: 'DESC' },
    });

    if (!latestSnapshot) {
      throw new Error(`No snapshot found for vault ${vaultId}`);
    }

    const claims: Partial<Claim>[] = [];

    // 1. Create claim for vault creator (20% of monthly amount)
    const creatorMonthlyAmount = Math.floor(allocation.creatorAllocation / 12);

    claims.push({
      user: { id: vault.owner.id } as any,
      vault: { id: vaultId } as any,
      type: ClaimType.L4VA,
      amount: creatorMonthlyAmount,
      status: ClaimStatus.AVAILABLE,
      description: `L4VA Rewards - Month ${monthNumber + 1}/12 (Vault Creator)`,
      metadata: {
        l4va_role: 'AU',
        month: monthNumber + 1,
        snapshot_id: latestSnapshot.id,
        ...(monthNumber === 0 && {
          allocation, // Store allocation info in first month for reference
          lock_snapshot_id: lockSnapshotId,
        }),
      },
    });

    // 2. Create claims for VT holders (80% of monthly amount, split by holdings)
    const holdersMonthlyAmount = Math.floor(allocation.holdersAllocation / 12);
    const vtHolders = this.parseVTHolders(latestSnapshot.addressBalances);

    for (const holder of vtHolders) {
      const holderAmount = Math.floor(holdersMonthlyAmount * holder.percentage);

      if (holderAmount === 0) continue; // Skip dust amounts

      // Find or create user by address
      const user = await this.userRepository.findOne({
        where: { address: holder.address },
        select: ['id'],
      });

      // Skip if user doesn't exist - they need to create an account to claim
      if (!user) {
        this.logger.warn(
          `Skipping L4VA claim for address ${holder.address} in vault ${vaultId} - user account not found. ` +
            `User must create an account to claim rewards.`
        );
        continue;
      }

      claims.push({
        user: { id: user.id } as any,
        vault: { id: vaultId } as any,
        type: ClaimType.L4VA,
        amount: holderAmount,
        status: ClaimStatus.PENDING, // On hold for now
        description: `L4VA Rewards - Month ${monthNumber + 1}/12 (VT Holder)`,
        metadata: {
          l4va_role: 'AC/VI',
          month: monthNumber + 1,
          snapshot_id: latestSnapshot.id,
          vt_balance: holder.balance,
          vt_percentage: holder.percentage,
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

        // Keep calculation in BigInt for precision
        // Multiply by 10000 to get 4 decimal places, then convert to Number
        const percentageBigInt = (balanceBigInt * BigInt(10000)) / totalSupply;

        return {
          address,
          balance, // Keep as string to preserve precision
          percentage: Number(percentageBigInt) / 10000, // Only convert final percentage
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
   * Calculate vault's L4VA allocation based on TVL share
   * Simplified formula per Rob's feedback
   */
  private async calculateVaultL4VAAllocation(
    vaultId: string,
    lockDate: Date,
    vaultTVL: number
  ): Promise<L4VAAllocation | null> {
    try {
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

      // 1. Calculate vault's share of monthly budget
      const vaultShare = vaultTVL / totalWindowTVL;
      const totalAllocation = Math.floor(this.L4VA_MONTHLY_BUDGET * vaultShare);

      // 2. 20% to creator
      const creatorAllocation = Math.floor(totalAllocation * 0.2);

      // 3. 80% to VT holders (split by snapshot)
      const holdersAllocation = totalAllocation - creatorAllocation;

      const monthlyAmount = Math.floor(totalAllocation / 12);

      return {
        totalAllocation,
        monthlyAmount,
        creatorAllocation,
        holdersAllocation,
      };
    } catch (error) {
      this.logger.error(`Error calculating L4VA allocation for vault ${vaultId}:`, error);
      return null;
    }
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
