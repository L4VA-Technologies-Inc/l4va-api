import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationService } from '@/modules/notification/notification.service';

@Injectable()
export class NotificationEventsListener {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private notificationService: NotificationService) {}

  @OnEvent('vault.launched')
  async handleVaultLaunched(event: {
    vaultId: string;
    address: string;
    vaultName: string;
    contributionStartDate: string;
    contributionStartTime: string;
  }) {
    await this.notificationService.sendNotification({
      title: `Vault ${event.vaultName} launched!`,
      description: `You have launched ${event.vaultName} vault, with Contribution phase beginning on ${event.contributionStartDate} at ${event.contributionStartTime}`,
      address: event.address,
      vaultId: event.vaultId,
      vaultName: event.vaultName,
    });
  }

  @OnEvent('vault.contribution_complete')
  async handleContributionComplete(event: {
    vaultId: string;
    vaultName: string;
    totalValueLocked: number;
    contributorIds: string[];
  }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `${event.vaultName} contribution stage complete`,
        description: `${event.vaultName} vault has successfully completed contribution stage. Total value locked = ${event.totalValueLocked.toLocaleString()} ADA`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.contributorIds
    );
  }

  @OnEvent('vault.success')
  async handleVaultSuccess(event: {
    vaultId: string;
    vaultName: string;
    tokenHolderIds: string[];
    adaSpent: number;
    tokenPercentage: number;
    tokenTicker: string;
    impliedVaultValue: number;
  }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `${event.vaultName} vault success!`,
        description: `${event.vaultName} vault has successfully completed acquire phase and locked. ${event.adaSpent.toLocaleString()} ADA was sent to acquire ${event.tokenPercentage}% of ${event.tokenTicker} tokens. Implied vault value is ${event.impliedVaultValue.toLocaleString()} ADA`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.tokenHolderIds
    );
  }

  @OnEvent('vault.failed')
  async handleVaultFailed(event: { vaultId: string; vaultName: string; contributorIds: string[] }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `${event.vaultName} vault failed`,
        description: `${event.vaultName} vault has failed to completed acquire phase. Assets and ADA will be refunded minus fees.`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.contributorIds
    );
  }

  @OnEvent('vault.favorite_launched') // Haven`t added
  async handleFavoriteVaultLaunched(event: { vaultId: string; address: string; vaultName: string }) {
    await this.notificationService.sendNotification({
      title: `Favorite vault ${event.vaultName} has launched`,
      description: `Your favorite vault ${event.vaultName} has launched and is now available for contribution!`,
      address: event.address,
      vaultId: event.vaultId,
      vaultName: event.vaultName,
    });
  }

  @OnEvent('vault.whitelist_added') // Haven`t added
  async handleWhitelistAdded(event: { vaultId: string; userIds: string[]; vaultName: string }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `You've been whitelisted for Vault ${event.vaultName}`,
        description: `Congratulations! You've been whitelisted for Vault ${event.vaultName}. You can now participate in the contribution phase.`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.userIds
    );
  }

  @OnEvent('vault.reserve_met') // Haven`t added
  async handleReserveMet(event: { vaultId: string; vaultName: string; address: string; subscriberIds: string[] }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `Reserve has been met on Vault ${event.vaultName}`,
        description: `Great news! The reserve has been met on Vault ${event.vaultName}. The vault is now progressing to the next phase.`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.subscriberIds
    );
  }

  @OnEvent('vault.time_running_out') // Haven`t added
  async handleTimeRunningOut(event: {
    vaultId: string;
    vaultName: string;
    phase: 'contribution' | 'acquire';
    subscriberIds: string[];
  }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `Time running out on Vault ${event.vaultName}`,
        description: `Time is running out to ${event.phase} on your saved/favorited vault ${event.vaultName}. Act now!`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.subscriberIds
    );
  }

  @OnEvent('governance.proposal_created') // haven`t added
  async handleProposalCreated(event: {
    address: string;
    vaultId: string;
    vaultName: string;
    proposalName: string;
    creatorId: string;
    tokenHolderIds: string[];
  }) {
    await this.notificationService.sendNotification({
      title: 'Governance Proposal Created',
      description: `Your "${event.proposalName}" Governance Proposal for vault ${event.vaultName} has been created!`,
      vaultId: event.vaultId,
      vaultName: event.vaultName,
      address: event.address,
    });

    const otherHolders = event.tokenHolderIds.filter(id => id !== event.creatorId);
    await this.notificationService.sendBulkNotification(
      {
        title: 'Governance Proposal Created',
        description: `Your "${event.proposalName}" Governance Proposal for vault ${event.vaultName} has been created!`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      otherHolders
    );
  }

  @OnEvent('governance.vote_complete') // Haven`t added
  async handleVoteComplete(event: {
    vaultId: string;
    vaultName: string;
    proposalName: string;
    tokenHolderIds: string[];
  }) {
    await this.notificationService.sendBulkNotification(
      {
        title: 'Governance Vote Complete',
        description: `Voting has ended for "${event.proposalName}" proposal for ${event.vaultName} vault. Check the results now!`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.tokenHolderIds
    );
  }

  @OnEvent('governance.vote_time_running_out') // Haven`t added
  async handleVoteTimeRunningOut(event: {
    vaultId: string;
    vaultName: string;
    proposalName: string;
    nonVoterIds: string[];
  }) {
    await this.notificationService.sendBulkNotification(
      {
        title: `Time running out on Proposal ${event.proposalName}`,
        description: `Time is running out on Proposal "${event.proposalName}" in vault ${event.vaultName}. Cast your vote now!`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.nonVoterIds
    );
  }

  @OnEvent('distribution.claim_available')
  async handleDistributionClaim(event: {
    vaultId: string;
    vaultName: string;
    tokenHolderIds: string[];
  }): Promise<void> {
    await this.notificationService.sendBulkNotification(
      {
        title: 'Distribution Claim Available',
        description: `You have a new token distribution claim available from vault ${event.vaultName}. Claim your tokens now!`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.tokenHolderIds
    );
  }

  @OnEvent('vault.termination') // Haven`t added
  async handleVaultTermination(event: {
    vaultId: string;
    vaultName: string;
    vaultTokenTicker: string;
    address: string;
    tokenHolderIds: string[];
  }) {
    await this.notificationService.sendBulkNotification(
      {
        title: 'Vault Termination',
        description: `Vault ${event.vaultName} has been terminated. Claim your final token distribution and burn your ${event.vaultTokenTicker} tokens now!`,
        address: event.address,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.tokenHolderIds
    );
  }

  // MILESTONE NOTIFICATIONS
  @OnEvent('milestone.tvl_reached') // Haven`t added
  async handleTVLMilestone(event: {
    vaultId: string;
    vaultName: string;
    milestoneAda: number;
    milestoneUsd: number;
    subscriberIds: string[];
  }): Promise<void> {
    await this.notificationService.sendBulkNotification(
      {
        title: `TVL milestone hit in vault ${event.vaultName}`,
        description: `TVL milestone ${event.milestoneAda.toLocaleString()} ADA / ${event.milestoneUsd.toLocaleString()} USD hit in vault ${event.vaultName}. Let's go!`,
        vaultId: event.vaultId,
        vaultName: event.vaultName,
      },
      event.subscriberIds
    );
  }

  @OnEvent('milestone.market_cap_reached') // Haven`t added
  async handleMarketCapMilestone(event: {
    tokenTicker: string;
    milestoneAda: number;
    milestoneUsd: number;
    tokenHolderIds: string[];
  }): Promise<void> {
    await this.notificationService.sendBulkNotification(
      {
        title: `Market Cap milestone hit on ${event.tokenTicker}`,
        description: `Market Cap milestone ${event.milestoneAda.toLocaleString()} ADA / ${event.milestoneUsd.toLocaleString()} USD hit on ${event.tokenTicker}. Let's go!`,
      },
      event.tokenHolderIds
    );
  }
}
