import { CheckCircle, XCircle, Ellipsis, AlertCircle, Download, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import toast from 'react-hot-toast';

import PrimaryButton from '../shared/PrimaryButton';
import SecondaryButton from '../shared/SecondaryButton';

import { ProposalField } from './ProposalInfo/ProposalField';
import { ProposalListField } from './ProposalInfo/ProposalListField';
import { MarketplaceActionsList } from './ProposalInfo/MarketplaceActionsList';
import { AssetWhitelistUpdateList } from './ProposalInfo/AssetWhitelistUpdateList';
import { AssetsList } from './ProposalInfo/AssetsList';
import { VoteButton } from './ProposalInfo/VoteButton';
import { VoteResultBar } from './ProposalInfo/VoteResultBar';
import { ProposalEndDate } from './ProposalEndDate';
import { VaultSkeleton } from './VaultSkeleton';

import { formatDateWithTime, formatDateTime } from '@/utils/core.utils';
import { ProposalTypeLabels } from '@/utils/types';
import { useGovernanceProposal, useVoteOnProposal } from '@/services/api/queries.js';
import { useAuth } from '@/lib/auth/auth';
import { useModalControls } from '@/lib/modals/modal.context';
import { getInProgressMessage, getSuccessMessage, getTerminationStatusMessage } from '@/constants/proposalMessages';

const ProposalInfoSkeleton = () => (
  <div>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="col-span-1 md:col-span-2 md:row-span-3 bg-steel-950 border border-steel-750 rounded-lg p-6 space-y-8">
        {/* Countdown skeleton */}
        <div className="space-y-2">
          <VaultSkeleton className="h-5 w-48 bg-steel-800" />
        </div>

        {/* Main content skeleton */}
        <div className="flex w-full justify-between gap-8 bg-steel-850 rounded-lg p-6 sm:flex-row flex-col">
          <div className="w-full space-y-4">
            <div className="flex justify-between items-start">
              <VaultSkeleton className="h-4 w-24 bg-steel-800" />
              <VaultSkeleton className="h-4 w-32 bg-steel-700" />
            </div>
            <div className="space-y-2">
              <VaultSkeleton className="h-4 w-32 bg-steel-800" />
              <VaultSkeleton className="h-16 w-full bg-steel-700" />
            </div>
          </div>
          <div className="w-full space-y-3">
            {[...Array(4)].map((_, idx) => (
              <div key={idx} className="flex justify-between">
                <VaultSkeleton className="h-4 w-24 bg-steel-800" />
                <VaultSkeleton className="h-4 w-32 bg-steel-700" />
              </div>
            ))}
          </div>
        </div>

        {/* Voting buttons skeleton */}
        <div className="space-y-4">
          {[...Array(3)].map((_, idx) => (
            <VaultSkeleton key={idx} className="h-12 w-full bg-steel-850 rounded-lg" />
          ))}
          <div className="flex justify-center mt-4">
            <VaultSkeleton className="h-10 w-60 bg-steel-800 rounded-lg" />
          </div>
        </div>
      </div>

      {/* Votes section skeleton */}
      <div className="bg-steel-950 border border-steel-750 rounded-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3">
            <VaultSkeleton className="h-6 w-16 bg-steel-800" />
            <VaultSkeleton className="h-6 w-8 bg-steel-700" />
          </div>
        </div>
        <div className="space-y-2">
          {[...Array(3)].map((_, idx) => (
            <div key={idx} className="flex items-center justify-between gap-2">
              <VaultSkeleton className="h-4 w-24 bg-steel-800" />
              <VaultSkeleton className="h-4 w-12 bg-steel-700" />
            </div>
          ))}
        </div>
      </div>

      {/* Information section skeleton */}
      <div className="bg-steel-950 border border-steel-750 rounded-lg p-6 space-y-6">
        <div className="space-y-3">
          <VaultSkeleton className="h-6 w-24 bg-steel-800" />
          {[...Array(5)].map((_, idx) => (
            <div key={idx} className="flex justify-between">
              <VaultSkeleton className="h-4 w-20 bg-steel-800" />
              <VaultSkeleton className="h-4 w-32 bg-steel-700" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <VaultSkeleton className="h-6 w-20 bg-steel-800" />
          <VaultSkeleton className="h-8 w-full bg-steel-700 rounded" />
        </div>
      </div>
    </div>
  </div>
);

export const ProposalInfo = ({ proposalId }) => {
  const { user } = useAuth();
  const { openModal } = useModalControls();
  const router = useRouter();

  const { data: response, refetch } = useGovernanceProposal(proposalId);

  const proposalInfo = response?.data?.proposal;
  const proposalBurnAssetsInfo = response?.data?.burnAssets;
  const proposalDistributionInfo = response?.data?.distributionInfo;
  const proposalDistributionStatus = response?.data?.distributionStatus;
  const proposalFungibleTokensInfo = response?.data?.fungibleTokens;
  const proposalNonFungibleTokensInfo = response?.data?.nonFungibleTokens;
  const marketplaceActionsInfo = response?.data?.marketplaceActions;
  const [canVote, setCanVote] = useState(response?.data?.canVote);
  const votes = response?.data?.votes || [];
  const totalVotes = response?.data?.votes?.length;
  const proposer = response?.data?.proposer;
  const [selectedVote, setSelectedVote] = useState(response?.data?.selectedVote);

  const getTerminationProgress = status => {
    const statuses = [
      'initiated',
      'nft_burning',
      'nft_burned',
      'lp_removal_pending',
      'lp_removal_awaiting',
      'lp_return_received',
      'vt_burned',
      'ada_in_treasury',
      'claims_created',
      'claims_processing',
      'claims_complete',
      'vault_burned',
      'treasury_cleaned',
    ];
    const currentIndex = statuses.indexOf(status);
    return currentIndex >= 0 ? Math.round(((currentIndex + 1) / statuses.length) * 100) : 0;
  };

  const handleOwnerProposalClick = id => {
    router.navigate({
      to: '/profile/$id',
      params: { id },
    });
  };

  const getMarketplaceActionMessage = () => {
    const actions = proposalInfo?.metadata?.marketplaceActions;
    if (!actions || actions.length === 0) return 'All marketplace actions have been successfully executed.';

    const actionGroups = {
      SELL: [],
      BUY: [],
      UNLIST: [],
      UPDATE_LISTING: [],
      OFFER: [],
      CANCEL_OFFER: [],
    };

    // Group actions by type
    actions.forEach(action => {
      if (actionGroups[action.exec]) {
        actionGroups[action.exec].push(action);
      }
    });

    const messages = [];

    if (actionGroups.SELL.length > 0) {
      const count = actionGroups.SELL.length;
      const names = actionGroups.SELL.map(a => a.assetName).join(', ');
      messages.push(
        count === 1 ? `Listed ${names} for sale on the marketplace.` : `Listed ${count} assets for sale: ${names}.`
      );
    }

    if (actionGroups.BUY.length > 0) {
      const count = actionGroups.BUY.length;
      const names = actionGroups.BUY.map(a => a.assetName).join(', ');
      messages.push(count === 1 ? `Purchased ${names} from the marketplace.` : `Purchased ${count} assets: ${names}.`);
    }

    if (actionGroups.UNLIST.length > 0) {
      const count = actionGroups.UNLIST.length;
      const names = actionGroups.UNLIST.map(a => a.assetName).join(', ');
      messages.push(count === 1 ? `Unlisted ${names} from the marketplace.` : `Unlisted ${count} assets: ${names}.`);
    }

    if (actionGroups.UPDATE_LISTING.length > 0) {
      const count = actionGroups.UPDATE_LISTING.length;
      const names = actionGroups.UPDATE_LISTING.map(a => a.assetName).join(', ');
      messages.push(
        count === 1 ? `Updated listing price for ${names}.` : `Updated listing prices for ${count} assets: ${names}.`
      );
    }

    if (actionGroups.OFFER.length > 0) {
      const count = actionGroups.OFFER.length;
      const names = actionGroups.OFFER.map(a => a.assetName).join(', ');
      messages.push(count === 1 ? `Placed an offer for ${names}.` : `Placed offers for ${count} assets: ${names}.`);
    }

    if (actionGroups.CANCEL_OFFER.length > 0) {
      const count = actionGroups.CANCEL_OFFER.length;
      const names = actionGroups.CANCEL_OFFER.map(a => a.assetName).join(', ');
      messages.push(count === 1 ? `Cancelled offer for ${names}.` : `Cancelled offers for ${count} assets: ${names}.`);
    }

    return messages.length > 0 ? messages.join(' ') : 'All marketplace actions have been successfully executed.';
  };

  const informationItems = [
    {
      label: 'Proposer',
      value: proposer?.address
        ? `${proposer.address.substring(0, 6)}...${proposer.address.substring(proposer.address.length - 6)}`
        : 'N/A',
      onClick: () => proposer && handleOwnerProposalClick(proposer?.id),
    },
    { label: 'IPFS', value: proposalInfo?.ipfsHash || 'N/A' },
    { label: 'Voting system', value: proposalInfo?.votingSystem ?? 'Single choice' },
    { label: 'Start at', value: proposalInfo?.startDate ? formatDateWithTime(proposalInfo.startDate) : 'N/A' },
    { label: 'End at', value: proposalInfo?.endDate ? formatDateWithTime(proposalInfo.endDate) : 'N/A' },
  ];

  const getProposalData = () => {
    const executionOptions = {
      label: 'Execution Options',
      value: ProposalTypeLabels[proposalInfo?.proposalType] || 'N/A',
    };

    switch (proposalInfo?.proposalType) {
      case 'staking': {
        const stakingItems = [executionOptions];
        if (proposalFungibleTokensInfo?.length > 0) {
          stakingItems.push({
            label: 'Fungible Tokens',
            value: proposalFungibleTokensInfo,
            type: 'fungible_tokens_list',
          });
        }
        if (proposalNonFungibleTokensInfo?.length > 0) {
          stakingItems.push({
            label: 'Non Fungible Tokens',
            value: proposalNonFungibleTokensInfo,
            type: 'non_fungible_tokens_list',
          });
        }
        return stakingItems;
      }

      case 'distribution': {
        const distributionItems = [executionOptions];

        if (proposalDistributionInfo) {
          distributionItems.push({
            label: 'Total Amount',
            value: `${proposalDistributionInfo.totalAdaAmount?.toLocaleString()} ADA`,
          });
          distributionItems.push({
            label: 'Eligible Recipients',
            value: `${proposalDistributionInfo.eligibleHolders} of ${proposalDistributionInfo.totalHolders} holders`,
          });
          if (proposalDistributionInfo.skippedHolders > 0) {
            distributionItems.push({
              label: 'Skipped Recipients',
              value: `${proposalDistributionInfo.skippedHolders} (below min ${proposalDistributionInfo.minAdaPerRecipient} ADA)`,
            });
          }
        }

        // Show execution status if available
        if (proposalDistributionStatus) {
          distributionItems.push({
            label: 'Batches',
            value: `${proposalDistributionStatus.completedBatches}/${proposalDistributionStatus.totalBatches} completed`,
          });
          if (proposalDistributionStatus.totalDistributed) {
            const distributedAda = parseInt(proposalDistributionStatus.totalDistributed) / 1000000;
            distributionItems.push({
              label: 'Distributed',
              value: `${distributedAda.toLocaleString()} ADA`,
            });
          }
        }

        return distributionItems;
      }

      case 'termination':
        return [''];

      case 'burning':
        return proposalBurnAssetsInfo?.length > 0
          ? [executionOptions, { label: 'Burn Assets', value: proposalBurnAssetsInfo, type: 'burn_assets_list' }]
          : [];

      case 'buy_sell':
        return marketplaceActionsInfo.length > 0
          ? [executionOptions, { label: 'Actions', value: marketplaceActionsInfo, type: 'buy_sell_list' }]
          : [];

      case 'marketplace_action':
        return marketplaceActionsInfo.length > 0
          ? [executionOptions, { label: 'Actions', value: marketplaceActionsInfo, type: 'marketplace_actions_list' }]
          : [];

      case 'expansion': {
        const expansionItems = [executionOptions];
        const expansionConfig = proposalInfo?.metadata?.expansion;

        if (expansionConfig) {
          // Whitelisted Collections - show as expandable list
          if (expansionConfig.policyIds && expansionConfig.policyIds.length > 0) {
            expansionItems.push({
              label: 'Whitelisted Collections',
              value: {
                policyIds: expansionConfig.policyIds,
                labels: expansionConfig.labels || [],
              },
              type: 'expansion_policy_list',
            });
          }

          // Duration
          if (expansionConfig.noLimit) {
            expansionItems.push({
              label: 'Duration',
              value: 'No time limit',
            });
          } else if (expansionConfig.duration) {
            const days = Math.floor(expansionConfig.duration / (24 * 60 * 60 * 1000));
            const hours = Math.floor((expansionConfig.duration % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            expansionItems.push({
              label: 'Duration',
              value: days > 0 ? `${days} day${days > 1 ? 's' : ''}` : `${hours} hour${hours > 1 ? 's' : ''}`,
            });
          }

          // Asset Max / Progress
          if (expansionConfig.noMax) {
            expansionItems.push({
              label: 'Asset Limit',
              value: 'No limit',
            });
          } else if (expansionConfig.assetMax) {
            const currentCount = expansionConfig.currentAssetCount || 0;
            const progressPercent = (currentCount / expansionConfig.assetMax) * 100;
            expansionItems.push({
              label: 'Asset Limit',
              value: `${currentCount} / ${expansionConfig.assetMax} assets (${progressPercent.toFixed(1)}%)`,
            });
          }

          // Pricing Method
          if (expansionConfig.priceType === 'limit' && expansionConfig.limitPrice) {
            expansionItems.push({
              label: 'Pricing Method',
              value: `Fixed: ${expansionConfig.limitPrice} VT per asset`,
            });
          } else if (expansionConfig.priceType === 'market') {
            expansionItems.push({
              label: 'Pricing Method',
              value: 'Market (current VT price)',
            });
          }
        }

        return expansionItems;
      }

      case 'asset_whitelist_update': {
        const whitelistItems = proposalInfo?.metadata?.assetsWhitelist ?? [];

        return whitelistItems.length > 0
          ? [
              executionOptions,
              {
                label: 'Policies to add',
                value: whitelistItems,
                type: 'asset_whitelist_update_list',
              },
            ]
          : [executionOptions];
      }

      case 'acquire_expansion': {
        const acquireExpansionItems = [executionOptions];
        const acquireExpansionConfig = proposalInfo?.metadata?.acquireExpansion;

        if (acquireExpansionConfig) {
          // Duration
          if (acquireExpansionConfig.noLimit) {
            acquireExpansionItems.push({
              label: 'Duration',
              value: 'No time limit',
            });
          } else if (acquireExpansionConfig.duration) {
            const days = Math.floor(acquireExpansionConfig.duration / (24 * 60 * 60 * 1000));
            const hours = Math.floor((acquireExpansionConfig.duration % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
            acquireExpansionItems.push({
              label: 'Duration',
              value: days > 0 ? `${days} day${days > 1 ? 's' : ''}` : `${hours} hour${hours > 1 ? 's' : ''}`,
            });
          }

          // Max ADA / Progress
          if (acquireExpansionConfig.noMax) {
            acquireExpansionItems.push({
              label: 'ADA Limit',
              value: 'No limit',
            });
          } else if (acquireExpansionConfig.maxAda) {
            const maxAdaAmount = acquireExpansionConfig.maxAda / 1000000; // Convert lovelace to ADA
            const currentAdaRaised = (acquireExpansionConfig.currentAdaRaised || 0) / 1000000;
            const progressPercent = (currentAdaRaised / maxAdaAmount) * 100;
            acquireExpansionItems.push({
              label: 'ADA Limit',
              value: `${currentAdaRaised.toLocaleString()} / ${maxAdaAmount.toLocaleString()} ₳ (${progressPercent.toFixed(1)}%)`,
            });
          }

          // Pricing Method
          if (acquireExpansionConfig.priceType === 'limit' && acquireExpansionConfig.limitPrice) {
            acquireExpansionItems.push({
              label: 'Pricing Method',
              value: `Fixed: ${acquireExpansionConfig.limitPrice} VT per 1 ₳`,
            });
          } else if (acquireExpansionConfig.priceType === 'market') {
            const marketPriceDisplay = acquireExpansionConfig.marketPriceSnapshot
              ? ` (${acquireExpansionConfig.marketPriceSnapshot.toFixed(6)} VT/₳ at proposal creation)`
              : '';
            acquireExpansionItems.push({
              label: 'Pricing Method',
              value: `Market (current LP price)${marketPriceDisplay}`,
            });
          }
        }

        return acquireExpansionItems;
      }

      default:
        return [];
    }
  };

  const voteOnProposal = useVoteOnProposal(proposalInfo?.vaultId);

  const handleVote = async (proposalId, voteType) => {
    if (!user) {
      openModal('LoginModal');
      return;
    }

    openModal('VoteConfirmModal', {
      voteType,
      proposalTitle: proposalInfo?.title,
      onConfirm: async () => {
        try {
          await voteOnProposal.mutateAsync({
            proposalId,
            voteData: {
              vote: voteType.toLowerCase(),
              voterAddress: user.address,
            },
          });
          setCanVote(false);
          setSelectedVote(voteType);
          toast.success('Your vote has been recorded successfully');
          await refetch();
        } catch (error) {
          console.error('Error voting on proposal:', error);
          const errorMessage = error.response?.data?.message || error.message || 'Failed to submit vote';
          toast.error(errorMessage);
        }
      },
    });
  };

  const handleExportVotes = () => {
    try {
      if (!votes || votes.length === 0) {
        toast.error('No votes to export');
        return;
      }

      toast.loading('Preparing CSV...', { id: 'download' });

      const headers = ['Vote', 'Wallet Address', 'Voting Weight (VT)', 'Timestamp'];

      const rows = votes.map(vote => {
        return [
          vote.vote || 'N/A',
          vote.voterAddress || 'N/A',
          vote.voteWeight || 'N/A',
          vote.timestamp ? formatDateTime(vote.timestamp) : vote.createdAt ? formatDateTime(vote.createdAt) : 'N/A',
        ];
      });

      const csvContent =
        'data:text/csv;charset=utf-8,' +
        [headers, ...rows].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `proposal_${proposalInfo?.id || 'votes'}_votes.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast.success('CSV downloaded successfully', { id: 'download' });
    } catch (err) {
      console.error(err);
      toast.error('Failed to export CSV', { id: 'download' });
    }
  };

  useEffect(() => {
    if (response?.data?.canVote !== undefined) {
      setCanVote(response.data.canVote);
    }
    if (response?.data?.selectedVote !== undefined) {
      setSelectedVote(response.data.selectedVote);
    }
  }, [response?.data?.canVote, response?.data?.selectedVote]);

  if (!proposalInfo) {
    return <ProposalInfoSkeleton />;
  }

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="col-span-1 md:col-span-2 md:row-span-3 bg-steel-950 border border-steel-750 rounded-lg p-6 space-y-8">
          <div className="space-y-2">
            <div className="text-dark-100 text-md mb-3">
              <ProposalEndDate
                startDate={proposalInfo?.startDate}
                endDate={proposalInfo?.endDate}
                proposalStatus={proposalInfo.status}
              />
            </div>
          </div>

          <div className="flex w-full justify-between gap-8 bg-steel-850 rounded-lg p-6 sm:flex-row flex-col">
            <div className="w-full space-y-2">
              <div className="flex justify-between">
                <h3 className="text-gray-400">Proposal title</h3>
                <span className="text-white break-words">{proposalInfo?.title}</span>
              </div>
              <div className="flex flex-col">
                <h3 className="text-gray-400">Proposal description</h3>
                <span className="text-white break-words">{proposalInfo?.description}</span>
              </div>
            </div>
            <div className="w-full">
              <div className="space-y-3">
                {proposalInfo &&
                  (() => {
                    const proposalData = getProposalData();
                    if (proposalData.length === 0) {
                      return informationItems.map((item, index) => (
                        <ProposalField key={index} label={item.label} value={item.value} onClick={item.onClick} />
                      ));
                    }

                    return proposalData.map((item, index) => {
                      if (item.type === 'list') {
                        return <ProposalListField key={index} label={item.label} value={item.value} />;
                      }

                      if (item.type === 'marketplace_actions_list') {
                        return <MarketplaceActionsList key={index} actions={item.value} type="marketplace" />;
                      }

                      if (item.type === 'buy_sell_list') {
                        return <MarketplaceActionsList key={index} actions={item.value} type="buy_sell" />;
                      }

                      if (item.type === 'distribution_assets_list') {
                        return <AssetsList key={index} assets={item.value} title="Distribution Assets" />;
                      }

                      if (item.type === 'burn_assets_list') {
                        return <AssetsList key={index} assets={item.value} title="Burn Assets" />;
                      }

                      if (item.type === 'fungible_tokens_list') {
                        return <AssetsList key={index} assets={item.value} title="Fungible Tokens" />;
                      }

                      if (item.type === 'non_fungible_tokens_list') {
                        return <AssetsList key={index} assets={item.value} title="Non Fungible Tokens" />;
                      }

                      if (item.type === 'expansion_policy_list') {
                        const { policyIds, labels } = item.value;
                        return (
                          <div key={index} className="space-y-2">
                            <h3 className="text-sm font-medium text-gray-400">{item.label}</h3>
                            <div className="bg-steel-900 rounded-lg p-4 space-y-3">
                              {policyIds.map((policyId, idx) => {
                                const label = labels && labels[idx] ? labels[idx] : null;
                                return (
                                  <div
                                    key={idx}
                                    className="p-3 bg-steel-850 rounded hover:bg-steel-800 transition-colors space-y-2"
                                  >
                                    {label && <div className="text-sm text-white font-medium">{label}</div>}
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-mono text-gray-400 break-all flex-1">
                                        {policyId}
                                      </span>
                                      <button
                                        onClick={e => {
                                          e.stopPropagation();
                                          navigator.clipboard
                                            .writeText(policyId)
                                            .then(() => {
                                              toast.success('Policy ID copied to clipboard');
                                            })
                                            .catch(err => {
                                              console.error('Failed to copy:', err);
                                              toast.error('Failed to copy to clipboard');
                                            });
                                        }}
                                        className="p-1 hover:bg-steel-700 rounded-md transition-colors flex-shrink-0"
                                        type="button"
                                        title="Copy Policy ID"
                                      >
                                        <Copy className="w-4 h-4 text-gray-400 hover:text-white" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }

                      if (item.type === 'asset_whitelist_update_list') {
                        return <AssetWhitelistUpdateList key={index} assets={item.value} label={item.label} />;
                      }

                      return <ProposalField key={index} label={item.label} value={item.value} />;
                    });
                  })()}
              </div>
            </div>
          </div>
          <div className="space-y-4">
            {proposalInfo?.executionError ? (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6 space-y-3">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="h-5 w-5 text-red-500" />
                  <h3 className="text-lg font-semibold text-red-500">Execution Error</h3>
                </div>
                <div className="text-red-300">
                  {proposalInfo.executionError.userFriendlyMessage
                    ? proposalInfo.executionError.userFriendlyMessage
                    : proposalInfo.executionError.message}
                </div>
                {proposalInfo.executionError.timestamp && (
                  <div className="text-sm text-gray-400">
                    {formatDateWithTime(proposalInfo.executionError.timestamp)}
                  </div>
                )}
              </div>
            ) : proposalInfo.status === 'active' ? (
              <>
                <VoteButton
                  voteType="yes"
                  icon={CheckCircle}
                  label="Yes, pass this Proposal"
                  canVote={canVote}
                  isSelected={selectedVote === 'yes'}
                  onClick={() => setSelectedVote('yes')}
                />
                <VoteButton
                  voteType="no"
                  icon={XCircle}
                  label="No, do not pass this Proposal"
                  canVote={canVote}
                  isSelected={selectedVote === 'no'}
                  onClick={() => setSelectedVote('no')}
                />
                {proposalInfo?.abstain && (
                  <VoteButton
                    voteType="abstain"
                    icon={Ellipsis}
                    label="Do nothing"
                    canVote={canVote}
                    isSelected={selectedVote === 'abstain'}
                    onClick={() => setSelectedVote('abstain')}
                  />
                )}

                <div className="flex justify-center">
                  <PrimaryButton
                    className="w-60 rounded-lg flex items-center px-3 py-2 gap-2 cursor-pointer"
                    onClick={() => (canVote && selectedVote ? handleVote(proposalInfo.id, selectedVote) : null)}
                    disabled={!canVote || !selectedVote}
                  >
                    <span className="text-white-500 text-2md flex items-center">Vote</span>
                  </PrimaryButton>
                </div>

                <div className="text-center text-sm text-gray-400 italic">
                  * Voting power was calculated on{' '}
                  {proposalInfo?.createdAt ? formatDateWithTime(proposalInfo.createdAt) : 'proposal creation'} and will
                  not change during the voting period.
                </div>
              </>
            ) : proposalInfo.status === 'upcoming' ? (
              <div className="text-center py-8 space-y-4">
                <div className="text-gray-300">Voting for this proposal has not yet started.</div>
                <div className="text-sm text-gray-500">
                  Voting buttons will appear here once the voting period begins.
                </div>
              </div>
            ) : proposalInfo.status === 'passed' ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-6 text-center space-y-3">
                <div className="flex items-center justify-center space-x-2">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-500"></div>
                  <h3 className="text-lg font-semibold text-green-500">Execution in Progress</h3>
                </div>
                {proposalInfo?.proposalType === 'termination' && proposalInfo?.vault?.terminationMetadata?.status ? (
                  <div className="space-y-3">
                    <div className="w-full bg-steel-800 rounded-full h-2">
                      <div
                        className="bg-green-500 h-2 rounded-full transition-all duration-500"
                        style={{
                          width: `${getTerminationProgress(proposalInfo.vault.terminationMetadata.status)}%`,
                        }}
                      />
                    </div>
                    <div className="text-gray-300 font-medium">
                      {getTerminationStatusMessage(proposalInfo.vault.terminationMetadata.status)}
                    </div>
                    {proposalInfo.vault.terminationMetadata.status === 'claims_created' ||
                    proposalInfo.vault.terminationMetadata.status === 'claims_processing' ? (
                      <div className="text-sm text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded p-3">
                        VT holders can now claim their share of assets and ADA. Check the Claims tab to process your
                        claim.
                      </div>
                    ) : (
                      <div className="text-sm text-gray-400">
                        The termination process is running automatically. Please check back for updates.
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="text-gray-300">{getInProgressMessage(proposalInfo?.proposalType)}</div>
                    <div className="text-sm text-gray-400">
                      This proposal has been approved and is currently being executed on the blockchain. Please check
                      back shortly for the final status.
                    </div>
                  </>
                )}
              </div>
            ) : proposalInfo.status === 'executed' ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-6 text-center space-y-3">
                <div className="flex items-center justify-center space-x-2">
                  <CheckCircle className="h-6 w-6 text-green-500" />
                  <h3 className="text-lg font-semibold text-green-500">Successfully Executed</h3>
                </div>
                <div className="text-gray-300">
                  {proposalInfo?.proposalType === 'marketplace_action' || proposalInfo?.proposalType === 'buy_sell'
                    ? getMarketplaceActionMessage()
                    : getSuccessMessage(proposalInfo?.proposalType, proposalInfo?.vault)}
                </div>
                {proposalInfo?.executionDate && (
                  <div className="text-sm text-gray-400">
                    Executed on {formatDateWithTime(proposalInfo.executionDate)}
                  </div>
                )}
              </div>
            ) : proposalInfo?.status === 'rejected' ? (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6 text-center space-y-3">
                <div className="flex items-center justify-center space-x-2">
                  <XCircle className="h-6 w-6 text-red-500" />
                  <h3 className="text-lg font-semibold text-red-500">Proposal Rejected</h3>
                </div>
                <div className="text-gray-300">
                  {(() => {
                    const totals = response?.data?.totals;
                    const yesVotes = totals?.yes ? parseFloat(totals.yes) : 0;
                    const noVotes = totals?.no ? parseFloat(totals.no) : 0;
                    const abstainVotes = totals?.abstain ? parseFloat(totals.abstain) : 0;
                    const totalVotingPower = yesVotes + noVotes + abstainVotes;

                    if (totalVotingPower === 0) {
                      return 'This proposal did not receive any votes during the voting period and was automatically rejected.';
                    }

                    if (noVotes > yesVotes) {
                      return 'This proposal was rejected by the community. The majority voted against this proposal.';
                    }

                    return 'This proposal did not meet the requirements to pass and was rejected.';
                  })()}
                </div>
                <div className="text-sm text-gray-400">
                  You can view the voting results below to see how the community voted.
                </div>
              </div>
            ) : (
              <div className="text-center py-8 space-y-4">
                <div className="text-gray-300">
                  This proposal voting period has concluded. You can view the final results below.
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-steel-950 border border-steel-750 rounded-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-3">
              <h3 className="text-1xl font-bold">Votes</h3>
              <h3 className="text-orange-500 text-1xl font-bold">{totalVotes}</h3>
            </div>
            {votes.length > 0 && (
              <SecondaryButton className="text-sm py-1.5 px-3" onClick={handleExportVotes}>
                <Download className="w-4 h-4" />
                Export CSV
              </SecondaryButton>
            )}
          </div>
          <div className="space-y-2">
            {votes.length ? (
              votes.map((vote, index) => (
                <div key={index} className="flex items-center justify-between gap-2">
                  <div className="text-gray-400">{`${vote.voterAddress?.substring(0, 6)}...${vote.voterAddress?.substring(vote.voterAddress.length - 6)}`}</div>
                  <div className="text-white">{vote.vote}</div>
                </div>
              ))
            ) : (
              <div className="text-center">No votes</div>
            )}
          </div>
        </div>
        <div className="bg-steel-950 border border-steel-750 rounded-lg p-6 space-y-6">
          <div className="space-y-3">
            <h3 className="text-1xl font-bold">Information</h3>
            {informationItems.map((item, index) => (
              <div key={index} className="flex justify-between">
                <div className="text-gray-400">{item.label}</div>
                <div
                  className={`text-white ${item.onClick ? 'cursor-pointer hover:text-orange-500' : ''}`}
                  onClick={item.onClick}
                >
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <h3 className="text-1xl font-bold">Results</h3>
            <VoteResultBar votes={proposalInfo.votes} hasAbstain={proposalInfo?.abstain} />
            <div className="text-xs text-gray-400 italic mt-2">
              * Voting power was calculated on{' '}
              {proposalInfo?.createdAt ? formatDateWithTime(proposalInfo.createdAt) : 'proposal creation'} and will not
              change during the voting period.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
