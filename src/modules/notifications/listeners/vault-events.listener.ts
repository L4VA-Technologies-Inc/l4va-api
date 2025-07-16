import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationsService } from '../notifications.service';

@Injectable()
export class VaultEventsListener {
  constructor(private notificationsService: NotificationsService) {}

  // VAULT LAUNCH
  @OnEvent('vault.launched')
  async handleVaultLaunched(event: {
    vaultId: string;
    creatorId: string;
    vaultName: string;
    contributionStartDate: string;
    contributionStartTime: string;
  }): Promise<void> {
    await this.notificationsService.createNotification(
      event.creatorId,
      `Vault ${event.vaultName} launched!`,
      `You have launched ${event.vaultName} vault, with Contribution phase beginning on ${event.contributionStartDate} at ${event.contributionStartTime}`,
      'vault_launch',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'vault-launched',
        novuPayload: {
          vaultName: event.vaultName,
          contributionStartDate: event.contributionStartDate,
          contributionStartTime: event.contributionStartTime,
        },
      }
    );
  }

  // PRE-LOCKED NOTIFICATIONS
  @OnEvent('vault.contribution_complete')
  async handleContributionComplete(event: {
    vaultId: string;
    vaultName: string;
    totalValueLocked: number;
    contributorIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.contributorIds,
      `${event.vaultName} contribution stage complete`,
      `${event.vaultName} vault has successfully completed contribution stage. Total value locked = ${event.totalValueLocked.toLocaleString()} ADA`,
      'contribution_complete',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'contribution-complete',
        novuPayload: {
          vaultName: event.vaultName,
          totalValueLocked: event.totalValueLocked,
        },
      }
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
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.tokenHolderIds,
      `${event.vaultName} vault success!`,
      `${event.vaultName} vault has successfully completed acquire phase and locked. ${event.adaSpent.toLocaleString()} ADA was sent to acquire ${event.tokenPercentage}% of ${event.tokenTicker} tokens. Implied vault value is ${event.impliedVaultValue.toLocaleString()} ADA`,
      'vault_success',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'vault-success',
        novuPayload: {
          vaultName: event.vaultName,
          adaSpent: event.adaSpent,
          tokenPercentage: event.tokenPercentage,
          tokenTicker: event.tokenTicker,
          impliedVaultValue: event.impliedVaultValue,
        },
      }
    );
  }

  @OnEvent('vault.failed')
  async handleVaultFailed(event: { vaultId: string; vaultName: string; contributorIds: string[] }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.contributorIds,
      `${event.vaultName} vault failed`,
      `${event.vaultName} vault has failed to completed acquire phase. Assets and ADA will be refunded minus fees.`,
      'vault_failed',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'vault-failed',
        novuPayload: {
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('vault.favorite_launched')
  async handleFavoriteVaultLaunched(event: { vaultId: string; vaultName: string; userIds: string[] }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.userIds,
      `Favorite vault ${event.vaultName} has launched`,
      `Your favorite vault ${event.vaultName} has launched and is now available for contribution!`,
      'favorite_vault_launched',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'favorite-vault-launched',
        novuPayload: {
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('vault.whitelist_added')
  async handleWhitelistAdded(event: { vaultId: string; vaultName: string; userIds: string[] }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.userIds,
      `You've been whitelisted for Vault ${event.vaultName}`,
      `Congratulations! You've been whitelisted for Vault ${event.vaultName}. You can now participate in the contribution phase.`,
      'vault_whitelist_added',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'vault-whitelist-added',
        novuPayload: {
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('vault.reserve_met')
  async handleReserveMet(event: { vaultId: string; vaultName: string; subscriberIds: string[] }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.subscriberIds,
      `Reserve has been met on Vault ${event.vaultName}`,
      `Great news! The reserve has been met on Vault ${event.vaultName}. The vault is now progressing to the next phase.`,
      'vault_reserve_met',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'vault-reserve-met',
        novuPayload: {
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('vault.time_running_out')
  async handleTimeRunningOut(event: {
    vaultId: string;
    vaultName: string;
    subscriberIds: string[];
    phase: 'contribution' | 'acquire';
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.subscriberIds,
      `Time running out on Vault ${event.vaultName}`,
      `Time is running out to ${event.phase} on your saved/favorited vault ${event.vaultName}. Act now!`,
      'vault_time_running_out',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'vault-time-running-out',
        novuPayload: {
          vaultName: event.vaultName,
          phase: event.phase,
        },
      }
    );
  }

  // GOVERNANCE NOTIFICATIONS
  @OnEvent('governance.proposal_created')
  async handleProposalCreated(event: {
    proposalId: string;
    vaultId: string;
    vaultName: string;
    proposalName: string;
    creatorId: string;
    tokenHolderIds: string[];
  }): Promise<void> {
    // Notify creator
    await this.notificationsService.createNotification(
      event.creatorId,
      'Governance Proposal Created',
      `Your "${event.proposalName}" Governance Proposal for vault ${event.vaultName} has been created!`,
      'governance_proposal_created',
      {
        relatedEntityType: 'proposal',
        relatedEntityId: event.proposalId,
        actionUrl: `/governance/proposals/${event.proposalId}`,
        novuWorkflowId: 'proposal-created',
        novuPayload: {
          proposalName: event.proposalName,
          vaultName: event.vaultName,
        },
      }
    );

    // Notify other token holders
    const otherHolders = event.tokenHolderIds.filter(id => id !== event.creatorId);
    await this.notificationsService.createBulkNotifications(
      otherHolders,
      'New Governance Proposal',
      `${event.vaultName} vault has a new governance proposal. Vote on "${event.proposalName}" now!`,
      'new_governance_proposal',
      {
        relatedEntityType: 'proposal',
        relatedEntityId: event.proposalId,
        actionUrl: `/governance/proposals/${event.proposalId}`,
        novuWorkflowId: 'new-governance-proposal',
        novuPayload: {
          proposalName: event.proposalName,
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('governance.vote_complete')
  async handleVoteComplete(event: {
    proposalId: string;
    vaultId: string;
    vaultName: string;
    proposalName: string;
    tokenHolderIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.tokenHolderIds,
      'Governance Vote Complete',
      `Voting has ended for "${event.proposalName}" proposal for ${event.vaultName} vault. Check the results now!`,
      'governance_vote_complete',
      {
        relatedEntityType: 'proposal',
        relatedEntityId: event.proposalId,
        actionUrl: `/governance/proposals/${event.proposalId}`,
        novuWorkflowId: 'governance-vote-complete',
        novuPayload: {
          proposalName: event.proposalName,
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('governance.vote_time_running_out')
  async handleVoteTimeRunningOut(event: {
    proposalId: string;
    vaultId: string;
    vaultName: string;
    proposalName: string;
    nonVoterIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.nonVoterIds,
      `Time running out on Proposal ${event.proposalName}`,
      `Time is running out on Proposal "${event.proposalName}" in vault ${event.vaultName}. Cast your vote now!`,
      'governance_vote_time_running_out',
      {
        relatedEntityType: 'proposal',
        relatedEntityId: event.proposalId,
        actionUrl: `/governance/proposals/${event.proposalId}`,
        novuWorkflowId: 'governance-vote-time-running-out',
        novuPayload: {
          proposalName: event.proposalName,
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('distribution.claim_available')
  async handleDistributionClaim(event: {
    vaultId: string;
    vaultName: string;
    tokenHolderIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.tokenHolderIds,
      'Distribution Claim Available',
      `You have a new token distribution claim available from vault ${event.vaultName}. Claim your tokens now!`,
      'distribution_claim_available',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/claims`,
        novuWorkflowId: 'distribution-claim-available',
        novuPayload: {
          vaultName: event.vaultName,
        },
      }
    );
  }

  @OnEvent('vault.termination')
  async handleVaultTermination(event: {
    vaultId: string;
    vaultName: string;
    vaultTokenTicker: string;
    tokenHolderIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.tokenHolderIds,
      'Vault Termination',
      `Vault ${event.vaultName} has been terminated. Claim your final token distribution and burn your ${event.vaultTokenTicker} tokens now!`,
      'vault_termination',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/claims`,
        novuWorkflowId: 'vault-termination',
        novuPayload: {
          vaultName: event.vaultName,
          vaultTokenTicker: event.vaultTokenTicker,
        },
      }
    );
  }

  // MILESTONE NOTIFICATIONS
  @OnEvent('milestone.tvl_reached')
  async handleTVLMilestone(event: {
    vaultId: string;
    vaultName: string;
    milestoneAda: number;
    milestoneUsd: number;
    subscriberIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.subscriberIds,
      `TVL milestone hit in vault ${event.vaultName}`,
      `TVL milestone ${event.milestoneAda.toLocaleString()} ADA / ${event.milestoneUsd.toLocaleString()} USD hit in vault ${event.vaultName}. Let's go!`,
      'milestone_tvl_reached',
      {
        relatedEntityType: 'vault',
        relatedEntityId: event.vaultId,
        actionUrl: `/vaults/${event.vaultId}`,
        novuWorkflowId: 'milestone-tvl-reached',
        novuPayload: {
          vaultName: event.vaultName,
          milestoneAda: event.milestoneAda,
          milestoneUsd: event.milestoneUsd,
        },
      }
    );
  }

  @OnEvent('milestone.market_cap_reached')
  async handleMarketCapMilestone(event: {
    tokenTicker: string;
    milestoneAda: number;
    milestoneUsd: number;
    tokenHolderIds: string[];
  }): Promise<void> {
    await this.notificationsService.createBulkNotifications(
      event.tokenHolderIds,
      `Market Cap milestone hit on ${event.tokenTicker}`,
      `Market Cap milestone ${event.milestoneAda.toLocaleString()} ADA / ${event.milestoneUsd.toLocaleString()} USD hit on ${event.tokenTicker}. Let's go!`,
      'milestone_market_cap_reached',
      {
        relatedEntityType: 'token',
        relatedEntityId: event.tokenTicker,
        actionUrl: `/tokens/${event.tokenTicker}`,
        novuWorkflowId: 'milestone-market-cap-reached',
        novuPayload: {
          tokenTicker: event.tokenTicker,
          milestoneAda: event.milestoneAda,
          milestoneUsd: event.milestoneUsd,
        },
      }
    );
  }
}
