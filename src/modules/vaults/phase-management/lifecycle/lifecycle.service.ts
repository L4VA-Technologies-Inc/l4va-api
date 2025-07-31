import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionService } from '@/modules/distribution/distribution.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { ContributionService } from '@/modules/vaults/phase-management/contribution/contribution.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { AssetOriginType } from '@/types/asset.types';
import { ClaimStatus } from '@/types/claim.types';
import { TransactionType } from '@/types/transaction.types';
import {
  VaultStatus,
  ContributionWindowType,
  InvestmentWindowType,
  SmartContractVaultStatus,
} from '@/types/vault.types';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);
  private readonly adminHash: string;

  constructor(
    @InjectQueue('phaseTransition')
    private phaseTransitionQueue: Queue,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly contributionService: ContributionService,
    private readonly vaultManagingService: VaultManagingService,
    private readonly transactionsService: TransactionsService,
    private readonly distributionService: DistributionService,
    private readonly taptoolsService: TaptoolsService,
    private readonly configService: ConfigService
  ) {
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions(): Promise<void> {
    await this.handlePublishedToContribution();

    // Handle contribution -> acquire transitions
    await this.handleContributionToInvestment();

    // Handle acquire -> governance transitions
    await this.handleInvestmentToGovernance();
  }

  private async queuePhaseTransition(
    vaultId: string,
    newStatus: VaultStatus,
    transitionTime: Date,
    phaseStartField?: 'contribution_phase_start' | 'acquire_phase_start' | 'governance_phase_start'
  ): Promise<void> {
    const now = new Date();
    const delay = transitionTime.getTime() - now.getTime();
    const ONE_MINUTE_MS = 60 * 1000;

    if (delay <= 0) {
      // If transition time is now or in the past, execute immediately
      let scStatus: SmartContractVaultStatus | undefined;

      if (newStatus === VaultStatus.governance) {
        scStatus = SmartContractVaultStatus.SUCCESSFUL;
      } else if (newStatus === VaultStatus.contribution || newStatus === VaultStatus.acquire) {
        scStatus = SmartContractVaultStatus.OPEN;
      } else if (newStatus === VaultStatus.failed) {
        scStatus = SmartContractVaultStatus.CANCELLED;
      } else {
        scStatus = undefined;
      }

      await this.executePhaseTransition({ vaultId, newStatus, phaseStartField, newScStatus: scStatus });
    } else if (delay <= ONE_MINUTE_MS) {
      // If transition should happen within the next minute, create a precise delay job
      // await this.phaseTransitionQueue.add(
      //   'transitionPhase',
      //   {
      //     vaultId,
      //     newStatus,
      //     phaseStartField,
      //   },
      //   {
      //     delay,
      //     // Remove any existing jobs for this vault and phase to avoid duplicates
      //     jobId: `${vaultId}-${newStatus}`,
      //     removeOnComplete: 10,
      //     removeOnFail: 10,
      //   }
      // );
      // this.logger.log(
      //   `Queued precise phase transition for vault ${vaultId} to ${newStatus} ` +
      //     `in ${Math.round(delay / 1000)} seconds`
      // );
    } else {
      // If more than 1 minute away, don't queue - let future cron runs handle it
      this.logger.log(
        `Vault ${vaultId} phase transition to ${newStatus} scheduled in ${Math.round(delay / 1000)} seconds. ` +
          `Will be queued when closer to transition time.`
      );
    }
  }

  private async executePhaseTransition(data: {
    vaultId: string;
    newStatus: VaultStatus;
    phaseStartField?: 'contribution_phase_start' | 'acquire_phase_start' | 'governance_phase_start';
    newScStatus?: SmartContractVaultStatus;
    txHash?: string;
    acquire_multiplier?: [string, string, number][];
    ada_pair_multiplier?: number;
  }): Promise<void> {
    try {
      const vault = await this.vaultRepository.findOne({
        where: { id: data.vaultId },
      });

      if (!vault) {
        this.logger.error(`Vault ${data.vaultId} not found for phase transition`);
        return;
      }

      vault.vault_status = data.newStatus;
      if (data.newScStatus !== undefined) {
        vault.vault_sc_status = data.newScStatus;
        vault.last_update_tx_hash = data.txHash;
      }

      if (data.phaseStartField) {
        vault[data.phaseStartField] = new Date().toISOString();
      }

      if (data.ada_pair_multiplier) {
        vault.ada_pair_multiplier = data.ada_pair_multiplier;
      }

      if (data.acquire_multiplier) {
        vault.acquire_multiplier = data.acquire_multiplier;
      }

      await this.vaultRepository.save(vault);

      this.logger.log(
        `Executed immediate phase transition for vault ${vault.id} to ${data.newStatus}` +
          (data.phaseStartField ? ` and set ${data.phaseStartField}` : '')
      );
    } catch (error) {
      this.logger.error(`Failed to execute phase transition for vault ${data.vaultId}:`, error);
      throw error;
    }
  }

  private async queueContributionToAcquireTransition(vault: Vault, contributionEnd: Date): Promise<void> {
    // Check if vault has assets before queuing transition
    await this.contributionService.syncContributionTransactions(vault.id);
    const assets = await this.assetsRepository.find({
      where: { vault: { id: vault.id }, deleted: false },
    });
    const hasAssets = assets?.some(asset => !asset.deleted) || false;

    if (!hasAssets) {
      // Queue failure transition
      await this.queuePhaseTransition(vault.id, VaultStatus.failed, contributionEnd);
      return;
    }

    // Determine acquire phase start time based on vault configuration
    let acquireStartTime: Date;

    if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
      // Start acquire phase immediately when contribution ends
      acquireStartTime = contributionEnd;
    } else if (vault.acquire_open_window_type === InvestmentWindowType.custom && vault.acquire_open_window_time) {
      // Use custom start time, but ensure it's not before contribution ends
      const customTime = new Date(vault.acquire_open_window_time);
      acquireStartTime = customTime > contributionEnd ? customTime : contributionEnd;
    } else {
      this.logger.warn(`Vault ${vault.id} has invalid acquire window configuration`);
      return;
    }

    await this.queuePhaseTransition(vault.id, VaultStatus.acquire, acquireStartTime, 'acquire_phase_start');
  }

  private async executeContributionToAcquireTransition(vault: Vault): Promise<void> {
    try {
      // Calculate total value of assets in the vault
      const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);

      vault.total_assets_cost_ada = assetsValue.totalValueAda;
      vault.total_assets_cost_usd = assetsValue.totalValueUsd;

      // Calculate threshold Price
      vault.require_reserved_cost_ada = assetsValue.totalValueAda * (vault.acquire_reserve * 0.01);
      vault.require_reserved_cost_usd = assetsValue.totalValueUsd * (vault.acquire_reserve * 0.01);

      // For immediate acquire start
      if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.acquire,
          phaseStartField: 'acquire_phase_start',
        });
      }
      // For custom acquire start time
      else if (vault.acquire_open_window_type === InvestmentWindowType.custom && vault.acquire_open_window_time) {
        const now = new Date();
        const customTime = new Date(vault.acquire_open_window_time);

        if (now >= customTime) {
          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.acquire,
            phaseStartField: 'acquire_phase_start',
          });
        } else {
          // Queue for the custom time
          await this.queuePhaseTransition(vault.id, VaultStatus.acquire, customTime, 'acquire_phase_start');
        }
      }
    } catch (error) {
      this.logger.error(`Error executing contribution to acquire transition for vault ${vault.id}`, error);
    }
  }

  private async executeAcquireToGovernanceTransition(vault: Vault): Promise<void> {
    try {
      // Sync transactions one more time
      await this.contributionService.syncContributionTransactions(vault.id);

      // 1. Group assets by user
      const assetsByUsers = await this.getAssetsGroupedByUser(vault.id);
      const acquirerAdaMap: Record<string, number> = {};
      const contributorValueMap: Record<string, number> = {};
      let totalAcquiredAda = 0;
      let totalContributedValueAda = 0;

      // 2. Iterate over each user's assets and split by phase
      for (const userAssets of assetsByUsers) {
        const userId = userAssets.user_id;
        const assets = userAssets.assets;
        let userAcquiredAda = 0;
        let userContributedValueAda = 0;

        this.logger.log(
          `User ${userId} (${userAssets.user_wallet}) has ${userAssets.total_assets} assets in vault ${vault.id}: ${JSON.stringify(assets)}`
        );

        for (const asset of assets) {
          // Only ADA in acquired assets
          if (asset.origin_type === AssetOriginType.ACQUIRED) {
            userAcquiredAda += asset.quantity || 1;
            this.logger.debug(`User ${userId} asset ${asset.id}: ${asset.quantity} ADA`);
          }
          if (asset.origin_type === AssetOriginType.CONTRIBUTED) {
            try {
              const { priceAda } = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_name);
              const quantity = asset.quantity || 1;
              userContributedValueAda += priceAda * quantity;
            } catch (error) {
              this.logger.error(
                `Error getting price for asset ${asset.policy_id}.${asset.asset_name} for user ${userId} in vault ${vault.id}:`,
                error.message
              );
            }
          }

          if (userAcquiredAda > 0) {
            acquirerAdaMap[userId] = userAcquiredAda;
            totalAcquiredAda += userAcquiredAda;
          }
          if (userContributedValueAda > 0) {
            contributorValueMap[userId] = userContributedValueAda;
            totalContributedValueAda += userContributedValueAda;
          }
        }
      }
      this.logger.log(
        `Total acquired ADA across all users in vault ${vault.id}: ${totalAcquiredAda}, ` +
          `Total contributed value ADA: ${totalContributedValueAda}`
      );

      const requiredThresholdAda = vault.require_reserved_cost_ada || 0;
      const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

      vault.total_acquired_value_ada = totalAcquiredAda;
      await this.vaultRepository.save(vault);

      this.logger.log(
        `Vault ${vault.id} meets the threshold: ` +
          `Total contributed: ${totalAcquiredAda} ADA, ` +
          `Required: ${requiredThresholdAda} ADA`
      );

      if (meetsThreshold) {
        // 3. Calculate LP Tokens
        const { lpAdaAmount, lpVtAmount, vtPrice } = await this.distributionService.calculateLpTokens({
          vaultId: vault.id,
          vtSupply: vault.ft_token_supply || 0,
          totalValue: totalContributedValueAda,
          assetsOfferedPercent: vault.tokens_for_acquires * 0.01,
          lpPercent: vault.liquidity_pool_contribution * 0.01,
        });
        // Create LP claim record
        try {
          await this.claimRepository.save({
            vault: { id: vault.id },
            type: 'lp',
            amount: lpVtAmount,
            status: ClaimStatus.AVAILABLE,
            metadata: {
              lpAmount: lpAdaAmount,
              vtPrice: vtPrice,
            },
          });
          this.logger.log(`Created LP claim for vault owner: ${lpVtAmount} VT tokens (${lpAdaAmount} ADA)`);
        } catch (error) {
          this.logger.error(`Failed to create LP claim for vault ${vault.id}:`, error);
        }

        // 4. Calculate VT for acquirers
        for (const [userId, adaSent] of Object.entries(acquirerAdaMap)) {
          const vtResult = await this.distributionService.calculateAcquirerTokens({
            vaultId: vault.id,
            adaSent,
            numAcquirers: Object.keys(acquirerAdaMap).length,
            totalAcquiredValueAda: totalAcquiredAda,
            lpAdaAmount,
            lpVtAmount,
            vtPrice,
          });
          this.logger.debug(
            `--- Acquirer ${userId} will receive VT: ${vtResult.vtReceived} (for ADA sent: ${adaSent})`
          );

          // Create claim record for acquirer
          try {
            await this.claimRepository.save({
              user: { id: userId },
              vault: { id: vault.id },
              type: 'acquirer',
              amount: vtResult.vtReceived,
              status: ClaimStatus.AVAILABLE,
              metadata: {
                adaSent: adaSent,
                vtPrice: vtPrice,
              },
            });
            this.logger.log(`Created acquirer claim for user ${userId}: ${vtResult.vtReceived} VT tokens`);
          } catch (error) {
            this.logger.error(`Failed to create acquirer claim for user ${userId} in vault ${vault.id}:`, error);
          }
        }

        // 5. Calculate VT for contributors
        for (const [userId, valueAda] of Object.entries(contributorValueMap)) {
          const vtResult = await this.distributionService.calculateContributorTokens({
            vaultId: vault.id,
            valueContributed: valueAda,
            totalTvl: totalContributedValueAda,
            lpAdaAmount,
            lpVtAmount,
            vtPrice,
          });
          this.logger.debug(
            `--- Contributor ${userId} will receive VT: ${vtResult.vtRetained} (for value contributed: ${valueAda})`
          );

          // Create claim record for contributor
          try {
            await this.claimRepository.save({
              user: { id: userId },
              vault: { id: vault.id },
              type: 'contributor',
              amount: vtResult.vtRetained,
              status: ClaimStatus.AVAILABLE,
              metadata: {
                valueContributed: valueAda,
                vtPrice: vtPrice,
              },
            });
            this.logger.log(`Created contributor claim for user ${userId}: ${vtResult.vtRetained} VT tokens`);
          } catch (error) {
            this.logger.error(`Failed to create contributor claim for user ${userId} in vault ${vault.id}:`, error);
          }
        }

        const metadata = {
          vaultName: vault.asset_vault_name,
          customerAddress: vault.owner.address,
          adminKeyHash: this.adminHash,
          allowedPolicies: ['7350d27fee037e39e25ecd473e6220961cf55eb8e1b1d16a0e79f122'],
          contractType: 2, // Successful
          policyId: vault.policy_id,
          acquireMultiplier: [
            ['7350d27fee037e39e25ecd473e6220961cf55eb8e1b1d16a0e79f122', '', 25000000],
            ['', '', 10000000],
          ] as [string, string, number][], //test
          adaPairMultiplier: vault.ada_pair_multiplier || 1,
        };

        const transaction = await this.transactionsService.createTransaction({
          vault_id: vault.id,
          type: TransactionType.updateVault,
          assets: [], // No assets needed for this transaction as it's metadata update
          metadata,
        });

        const response = await this.vaultManagingService.updateVaultMetadataTx(transaction.id);

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.governance,
          phaseStartField: 'governance_phase_start',
          newScStatus: SmartContractVaultStatus.SUCCESSFUL,
          txHash: response.txHash,
          acquire_multiplier: metadata.acquireMultiplier,
          ada_pair_multiplier: metadata.adaPairMultiplier,
        });
      } else {
        this.logger.warn(
          `Vault ${vault.id} does not meet the threshold: ` +
            `Total contributed: ${totalAcquiredAda} ADA, ` +
            `Required: ${requiredThresholdAda} ADA`
        );

        // TODO: Burn the vault and refund assets
        this.logger.warn(`Vault ${vault.id} needs to be burned and assets refunded`);
        await this.executePhaseTransition({ vaultId: vault.id, newStatus: VaultStatus.failed });
      }
    } catch (error) {
      this.logger.error(`Error executing acquire to governance transition for vault ${vault.id}`, error);
    }
  }

  private async handlePublishedToContribution(): Promise<void> {
    // Handle immediate start vaults
    const immediateStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.uponVaultLaunch })
      .getMany();

    for (const vault of immediateStartVaults) {
      await this.executePhaseTransition({
        vaultId: vault.id,
        newStatus: VaultStatus.contribution,
        phaseStartField: 'contribution_phase_start',
        newScStatus: SmartContractVaultStatus.OPEN,
      });
    }

    // Handle custom start time vaults
    const customStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.custom })
      .andWhere('vault.contribution_open_window_time IS NOT NULL')
      .getMany();

    for (const vault of customStartVaults) {
      const transitionTime = new Date(vault.contribution_open_window_time);
      await this.queuePhaseTransition(vault.id, VaultStatus.contribution, transitionTime, 'contribution_phase_start');
    }
  }

  private async handleContributionToInvestment(): Promise<void> {
    const now = new Date();
    const contributionVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.contribution })
      .andWhere('vault.contribution_phase_start IS NOT NULL')
      .andWhere('vault.contribution_duration IS NOT NULL')
      .leftJoinAndSelect('vault.owner', 'owner')
      .getMany();

    for (const vault of contributionVaults) {
      const contributionStart = new Date(vault.contribution_phase_start);
      const contributionDurationMs = Number(vault.contribution_duration);
      const contributionEnd = new Date(contributionStart.getTime() + contributionDurationMs);

      // If contribution period hasn't ended yet, queue the transition
      if (now < contributionEnd) {
        await this.queueContributionToAcquireTransition(vault, contributionEnd);
        continue;
      }

      await this.contributionService.syncContributionTransactions(vault.id);

      const assets = await this.assetsRepository.find({ where: { vault: { id: vault.id }, deleted: false } });
      // Check if vault has any non-deleted assets
      const hasAssets = assets?.some(asset => !asset.deleted) || false;

      // If no assets, burn the vault using admin wallet
      if (!hasAssets) {
        try {
          this.logger.log(`Vault ${vault.id} has no assets and contribution period has ended. Burning vault...`);
          // Update vault status to failed
          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.failed,
            phaseStartField: null,
            newScStatus: SmartContractVaultStatus.CANCELLED,
          });

          // // Use admin wallet to burn the vault
          // const burnTx = await this.vaultContractService.createBurnTx({
          //   customerAddress: vault.owner.address, // Still track the original owner
          //   assetVaultName: vault.asset_vault_name,
          // });

          // // Submit the transaction using admin wallet
          // const { txHash } = await this.vaultContractService.submitOnChainVaultTx({
          //   transaction: burnTx.presignedTx,
          //   signatures: [], // Admin signature is already included in presignedTx
          // });

          // // Update vault status
          // vault.deleted = true;
          // vault.liquidation_hash = txHash;
          // await this.vaultRepository.save(vault);

          // this.logger.log(`Successfully burned empty vault ${vault.id} in transaction ${txHash}`);

          continue;
        } catch (error) {
          this.logger.error(`Failed to burn empty vault ${vault.id}:`, error.message);
          // Continue with other vaults even if one fails
        }
        continue;
      }

      // If we get here, the vault has assets and the contribution period has ended
      // Execute the transition immediately since the time has passed
      await this.executeContributionToAcquireTransition(vault);
    }
  }

  async getAssetsGroupedByUser(vaultId: string): Promise<
    {
      user_id: string;
      user_wallet: string;
      total_assets: string;
      assets: {
        id: string;
        type: string;
        contract_address: string | null;
        added_at: string;
        quantity: number;
        origin_type: AssetOriginType;
        policy_id: string;
        asset_name: string;
      }[];
    }[]
  > {
    const query = `
      SELECT
        u.id as user_id,
        u.address as user_wallet,
        COUNT(a.id) as total_assets,
        json_agg(
          json_build_object(
            'id', a.id,
            'type', a.type,
            'contract_address', a.contract_address,
            'added_at', a.added_at,
            'quantity', a.quantity,
            'origin_type', a.origin_type,
            'policy_id', a.policy_id,
            'asset_name', a.asset_id
          )
        ) as assets
      FROM
        assets a
      JOIN
        users u ON u.id = a.added_by
      WHERE
        a.vault_id = $1
      GROUP BY
        u.id, u.address
      ORDER BY
        u.address ASC
    `;

    const result = await this.assetsRepository.query(query, [vaultId]);
    return result;
  }

  private async handleInvestmentToGovernance(): Promise<void> {
    const acquireVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.acquire })
      .andWhere('vault.acquire_phase_start IS NOT NULL')
      .andWhere('vault.acquire_window_duration IS NOT NULL')
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets', 'assets')
      .getMany();

    const now = new Date();

    for (const vault of acquireVaults) {
      const acquireStart = new Date(vault.acquire_phase_start);
      const acquireDurationMs = Number(vault.acquire_window_duration);
      const acquireEnd = new Date(acquireStart.getTime() + acquireDurationMs);

      // If acquire period hasn't ended yet, queue the transition
      if (now < acquireEnd) {
        await this.queuePhaseTransition(vault.id, VaultStatus.governance, acquireEnd, 'governance_phase_start');
        continue;
      }

      if (now >= acquireEnd) {
        // Execute the transition immediately since the time has passed
        await this.executeAcquireToGovernanceTransition(vault);
      }
    }
  }
}
