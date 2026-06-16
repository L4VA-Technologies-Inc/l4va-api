import { useCallback, useState, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useWallet } from '@ada-anvil/weld/react';

import Staking from '@/components/modals/CreateProposalModal/Staking';
import Distributing from '@/components/modals/CreateProposalModal/Distributing';
import { ConfirmModal } from '@/components/modals/CreateProposalModal/ConfirmModal';
import { ModalWrapper } from '@/components/shared/ModalWrapper';
import { LavaSteelInput } from '@/components/shared/LavaInput';
import { LavaSteelTextarea } from '@/components/shared/LavaTextarea';
import { LavaSteelSelect } from '@/components/shared/LavaSelect';
import PrimaryButton from '@/components/shared/PrimaryButton';
import SecondaryButton from '@/components/shared/SecondaryButton';
import Terminating from '@/components/modals/CreateProposalModal/Terminating.jsx';
import Burning from '@/components/modals/CreateProposalModal/Burning.jsx';
import Expansion from '@/components/modals/CreateProposalModal/Expansion.jsx';
import AcquireExpansion from '@/components/modals/CreateProposalModal/AcquireExpansion.jsx';
import {
  useCreateProposal,
  useGovernanceProposals,
  useGovernanceFees,
  useSubmitProposalFeePayment,
  useDeleteProposal,
} from '@/services/api/queries';
import { LavaIntervalPicker } from '@/components/shared/LavaIntervalPicker.js';
import {
  MIN_TIME_FOR_VOTING,
  MAX_TIME_FOR_VOTING,
  VAULT_STATUSES,
} from '@/components/vaults/constants/vaults.constants.js';
import { LavaDatePicker } from '@/components/shared/LavaDatePicker.jsx';
import { MarketActions } from '@/components/modals/CreateProposalModal/MarketActions/MarketActions.jsx';
import AssetWhitelistUpdate from '@/components/modals/CreateProposalModal/AssetWhitelistUpdate.jsx';

const executionOptions = [
  { value: 'marketplace_action', label: 'Market Actions' },
  { value: 'expansion', label: 'Vault Expansion' },
  { value: 'asset_whitelist_update', label: 'Update Asset Whitelist' },
  { value: 'acquire_expansion', label: 'Acquire Expansion' },
  { value: 'distribution', label: 'Distribution - Coming Soon', disabled: true },
  { value: 'staking', label: 'Staking - Coming Soon', disabled: true },
  { value: 'termination', label: 'Termination - Coming Soon', disabled: true },
  { value: 'burning', label: 'Burning - Coming Soon', disabled: true },
  { value: 'add_remove_lp', label: 'Add/Remove LP - Coming Soon', disabled: true },
];

const initialProposalData = {
  isValid: true,
};

export const CreateProposalModal = ({ onClose, isOpen, vault }) => {
  const [proposalTitle, setProposalTitle] = useState('');
  const [proposalDescription, setProposalDescription] = useState('');
  const [selectedOption, setSelectedOption] = useState(
    vault.vaultStatus === VAULT_STATUSES.EXPANSION ? 'distribution' : 'marketplace_action'
  );
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [proposalData, setProposalData] = useState(initialProposalData);
  const [proposalStartDate, setProposalStartDate] = useState(null);
  const [proposalDuration, setProposalDuration] = useState(null);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState('idle');

  const wallet = useWallet('handler', 'isConnected');
  const createProposalMutation = useCreateProposal();
  const submitProposalFeePayment = useSubmitProposalFeePayment();
  const deleteProposalMutation = useDeleteProposal();
  const { data: governanceFees } = useGovernanceFees();

  const { refetch } = useGovernanceProposals(vault.id);

  // Get fee for current proposal type
  const currentProposalFee = useMemo(() => {
    if (!governanceFees?.data) return 0;
    const feeMap = {
      marketplace_action: governanceFees.data.proposalFeeMarketplaceAction,
      distribution: governanceFees.data.proposalFeeDistribution,
      expansion: governanceFees.data.proposalFeeExpansion,
      acquire_expansion: governanceFees.data.proposalFeeExpansion, // Use same fee as expansion
      asset_whitelist_update: governanceFees.data.proposalFeeAssetWhitelistUpdate,
      staking: governanceFees.data.proposalFeeStaking,
      termination: governanceFees.data.proposalFeeTermination,
      burning: governanceFees.data.proposalFeeBurning,
    };
    return feeMap[selectedOption] || 0;
  }, [governanceFees, selectedOption]);

  // Filter execution options based on vault status
  // During expansion or acquire_expansion, only Distribution is allowed (doesn't extract from vault)
  const availableExecutionOptions = useMemo(() => {
    const isExpansion =
      vault.vaultStatus === VAULT_STATUSES.EXPANSION || vault.vaultStatus === VAULT_STATUSES.ACQUIRE_EXPANSION;

    if (isExpansion) {
      return executionOptions.map(option => {
        if (option.value === 'distribution') {
          return option;
        }
        return {
          ...option,
          disabled: true,
          label: option.label + ' (Not available during expansion)',
        };
      });
    }

    return executionOptions;
  }, [vault.vaultStatus]);

  const handleCreateProposal = () => {
    // Validate voting duration constraints
    if (proposalDuration && (proposalDuration < MIN_TIME_FOR_VOTING || proposalDuration > MAX_TIME_FOR_VOTING)) {
      const minHours = MIN_TIME_FOR_VOTING / (1000 * 60 * 60);
      const maxDays = MAX_TIME_FOR_VOTING / (1000 * 60 * 60 * 24);
      toast.error(
        `Voting duration must be between ${minHours} hours and ${maxDays} days. Please adjust the voting period.`,
        { duration: 5000 }
      );
      setError(true);
      return;
    }

    if (!isValidProposal()) {
      setError(false);
      setShowConfirmation(true);
    } else {
      setError(true);
    }
  };

  const isValidProposal = () => {
    return (
      !proposalTitle.trim() ||
      proposalTitle.length > 200 ||
      !proposalDescription.trim() ||
      proposalDescription.length > 500 ||
      !proposalData.isValid ||
      !proposalStartDate ||
      !proposalDuration
    );
  };

  const handleConfirmCreate = async () => {
    setShowConfirmation(false);
    setStatus('creating');
    try {
      // Step 1: Check if wallet is connected
      if (!wallet.isConnected || !wallet.handler) {
        toast.error('Please connect your wallet first');
        setStatus('idle');
        return;
      }

      // Step 2: Build proposal payload
      const proposalPayload = {
        title: proposalTitle,
        description: proposalDescription,
        type: selectedOption,
        startDate: proposalStartDate.toISOString(),
        duration: proposalDuration,
      };

      if (selectedOption === 'staking') {
        proposalPayload.fts = proposalData.fts || [];
        proposalPayload.nfts = proposalData.nfts || [];
      } else if (selectedOption === 'distribution') {
        proposalPayload.distributionLovelaceAmount = proposalData.distributionLovelaceAmount;
      } else if (selectedOption === 'expansion') {
        proposalPayload.expansionPolicyIds = proposalData.expansionPolicyIds || [];
        proposalPayload.expansionDuration = proposalData.expansionDuration;
        proposalPayload.expansionNoLimit = proposalData.expansionNoLimit || false;
        proposalPayload.expansionAssetMax = proposalData.expansionAssetMax;
        proposalPayload.expansionNoMax = proposalData.expansionNoMax || false;
        proposalPayload.expansionPriceType = proposalData.expansionPriceType || 'market';
        proposalPayload.expansionLimitPrice = proposalData.expansionLimitPrice;
      } else if (selectedOption === 'asset_whitelist_update') {
        proposalPayload.assetsWhitelist = proposalData.assetsWhitelist || [];
      } else if (selectedOption === 'acquire_expansion') {
        proposalPayload.acquireExpansionDuration = proposalData.acquireExpansionDuration;
        proposalPayload.acquireExpansionNoLimit = proposalData.acquireExpansionNoLimit || false;
        proposalPayload.acquireExpansionMaxAda = proposalData.acquireExpansionMaxAda;
        proposalPayload.acquireExpansionNoMax = proposalData.acquireExpansionNoMax || false;
        proposalPayload.acquireExpansionPriceType = proposalData.acquireExpansionPriceType || 'market';
        proposalPayload.acquireExpansionLimitPrice = proposalData.acquireExpansionLimitPrice;
      } else if (selectedOption === 'termination') {
        proposalPayload.metadata = {
          proposalStart: proposalData.proposalStart || null,
          terminateAssets: proposalData.terminateAssets || [],
        };
      } else if (selectedOption === 'burning') {
        proposalPayload.metadata = {
          burnAssets: proposalData.burnAssets || [],
        };
      } else if (selectedOption === 'marketplace_action') {
        const marketActionType = proposalData.marketActionType || 'buy';

        if (marketActionType === 'swap') {
          proposalPayload.marketplaceActions = (proposalData.swapActions || []).map(action => ({
            assetId: action.assetId,
            exec: 'SELL',
            quantity: action.quantity,
            slippage: action.slippage,
            useMarketPrice: action.useMarketPrice !== false, // Default to true
            customPriceAda: action.useMarketPrice ? undefined : parseFloat(action.customPriceAda),
            market: 'DexHunter',
          }));
        } else if (marketActionType === 'update_list') {
          proposalPayload.marketplaceActions = (proposalData.updateListingAssets || [])
            .filter(asset => asset.newPrice && Number(asset.newPrice) > 0)
            .map(asset => ({
              assetId: asset.id,
              exec: 'UPDATE_LISTING',
              newPrice: asset.newPrice,
              market: asset.market || 'WayUp',
            }));
        } else if (marketActionType === 'sell' || marketActionType === 'buy_sell') {
          proposalPayload.type = 'buy_sell';
          proposalPayload.metadata = proposalData;
        } else if (marketActionType === 'buy') {
          proposalPayload.marketplaceActions = (proposalData.buyingSellingOptions || [])
            .filter(opt => opt.assetId && opt.assetId.length >= 56 && opt.price && Number(opt.price) >= 5)
            .map(opt => ({
              assetId: opt.assetId,
              exec: opt.exec,
              price: opt.price,
              market: opt.market || 'WayUp',
              assetName: opt.assetName,
            }));
        } else if (marketActionType === 'cancel_offer') {
          proposalPayload.marketplaceActions = (proposalData.cancelOfferAssets || []).map(asset => ({
            assetId: asset.id,
            exec: 'CANCEL_OFFER',
            market: asset.listing_market || asset.market || 'WayUp',
          }));
        } else {
          proposalPayload.marketplaceActions = (proposalData.unlistAssets || []).map(asset => ({
            assetId: asset.id,
            exec: 'UNLIST',
            market: asset.market || 'WayUp',
          }));
        }
      }

      // Step 3: Create proposal
      const createResponse = await createProposalMutation.mutateAsync({
        vaultId: vault.id,
        proposalData: proposalPayload,
      });

      if (!createResponse?.data) {
        throw new Error('Failed to create proposal');
      }

      const { proposal, requiresPayment, presignedTx } = createResponse.data;

      // Step 4: Handle payment if required
      if (requiresPayment && presignedTx) {
        try {
          // Sign fee transaction
          setStatus('signing');
          const signature = await wallet.handler.signTx(presignedTx, true);

          if (!signature) {
            throw new Error('Fee transaction signing was cancelled');
          }

          // Submit transaction with signatures to backend
          setStatus('submitting');
          const submitResponse = await submitProposalFeePayment.mutateAsync({
            proposalId: proposal.id,
            transaction: presignedTx,
            signatures: [signature],
          });

          if (!submitResponse?.data?.success) {
            throw new Error(submitResponse?.data?.message || 'Failed to submit fee transaction');
          }
        } catch (feeError) {
          console.error('Fee transaction failed:', feeError);

          // Check if user declined to sign
          const userCancelled = feeError?.message === 'user declined sign tx';

          let errorMsg = userCancelled
            ? 'Payment cancelled. Proposal was not created.'
            : 'Payment failed. Proposal was not created.';

          // Always delete the unpaid proposal when payment fails
          try {
            await deleteProposalMutation.mutateAsync(proposal.id);
          } catch (deleteError) {
            console.error('Failed to delete unpaid proposal:', deleteError);
            errorMsg = userCancelled
              ? 'Payment cancelled. Your proposal was saved as unpaid and can be deleted from the Governance tab.'
              : 'Payment failed. Your proposal was saved as unpaid and can be deleted from the Governance tab.';
          }

          toast.error(errorMsg, { duration: 7000 });
          setStatus('idle');
          await refetch();
          return;
        }
      }

      // Step 6: Success
      setStatus('success');
      await refetch();
      toast.success('Proposal created successfully!');
      onClose();
    } catch (error) {
      console.error('Failed to create proposal:', error);

      // Extract error message from API response
      let errorMessage = 'Failed to create proposal. Please try again.';

      if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;

        // Check if it's a swap amount too low error
        if (errorMessage.includes('Swap amount too low')) {
          // Already has helpful message with max amount suggestion
          toast.error(errorMessage, { duration: 8000 });
          return;
        }
        // Check if it's a pool not found error (genuinely no pool)
        else if (errorMessage.includes('No liquidity pool available')) {
          toast.error(`${errorMessage}\n\nThis token is not tradeable on DexHunter.`, {
            duration: 6000,
          });
          return;
        }
      } else if (error?.message) {
        errorMessage = error.message;
      }

      toast.error(errorMessage, { duration: 6000 });
    } finally {
      setStatus('idle');
    }
  };

  const handleDataChange = useCallback(data => {
    setProposalData(prev => ({ ...prev, ...data }));
  }, []);

  const handleChangeExecutionOption = value => {
    const option = executionOptions.find(opt => opt.value === value);
    if (option?.disabled) {
      return;
    }
    setProposalData(initialProposalData);
    setSelectedOption(value);
  };

  const renderFooter = () => {
    const isInvalid = isValidProposal();
    const feeInAda = currentProposalFee / 1000000;
    const isProcessing = status !== 'idle';

    const getButtonText = () => {
      switch (status) {
        case 'creating':
          return 'Creating Proposal...';
        case 'signing':
          return 'Signing...';
        case 'submitting':
          return 'Submitting...';
        case 'success':
          return 'Success!';
        default:
          return 'Create';
      }
    };

    return (
      <div className="flex justify-between items-center">
        <div className="text-sm">
          {currentProposalFee > 0 ? (
            <div className="flex flex-col">
              <span className="text-gray-400">New proposal</span>
              <span className="text-yellow-500 text-xs">Governance fee: {feeInAda.toFixed(2)} ADA</span>
            </div>
          ) : (
            <span className="text-gray-400">New proposal</span>
          )}
        </div>
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose} size="sm" disabled={isProcessing}>
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={handleCreateProposal}
            size="sm"
            className="capitalize"
            disabled={isInvalid || isProcessing}
          >
            {getButtonText()}
          </PrimaryButton>
        </div>
      </div>
    );
  };

  return (
    <>
      <ModalWrapper
        size="3xl"
        isOpen={isOpen}
        onClose={onClose}
        title={`Create Proposal for ${vault.name}`}
        maxHeight="90vh"
        footer={renderFooter()}
      >
        <div className="space-y-6">
          <div className="space-y-4">
            <LavaSteelInput
              className="border border-red-600"
              label="Proposal Title*"
              placeholder="Enter proposal title"
              value={proposalTitle}
              onChange={value => setProposalTitle(value)}
              error={error && (!proposalTitle || proposalTitle.length > 200)}
              helperText={`${proposalTitle.length}/200 characters`}
              maxLength={200}
            />
            <LavaSteelTextarea
              label="Proposal Description*"
              placeholder="Enter proposal description"
              value={proposalDescription}
              onChange={value => setProposalDescription(value)}
              error={error && (!proposalDescription || proposalDescription.length > 500)}
              helperText={`${proposalDescription.length}/500 characters`}
              maxLength={500}
            />
            <h3 className="text-lg font-medium">Execution Options</h3>
            <LavaSteelSelect
              options={availableExecutionOptions}
              placeholder="Select execution type"
              value={selectedOption}
              onChange={handleChangeExecutionOption}
            />
          </div>

          <div className="space-y-4">
            {selectedOption === 'staking' && (
              <Staking vaultId={vault?.id} onDataChange={handleDataChange} error={error} />
            )}
            {selectedOption === 'distribution' && (
              <Distributing
                isDisabled={executionOptions.find(opt => opt.value === 'distribution')?.disabled}
                vaultId={vault?.id}
                onDataChange={handleDataChange}
              />
            )}
            {selectedOption === 'termination' && (
              <Terminating
                vaultId={vault?.id}
                onClose={() => setSelectedOption('marketplace_action')}
                onDataChange={handleDataChange}
              />
            )}
            {selectedOption === 'burning' && (
              <Burning
                vaultId={vault?.id}
                onClose={() => setSelectedOption('marketplace_action')}
                onDataChange={handleDataChange}
                error={error}
              />
            )}
            {selectedOption === 'marketplace_action' && (
              <MarketActions vaultId={vault.id} onDataChange={handleDataChange} error={error} />
            )}
            {selectedOption === 'expansion' && (
              <Expansion vault={vault} onDataChange={handleDataChange} error={error} />
            )}
            {selectedOption === 'asset_whitelist_update' && (
              <AssetWhitelistUpdate vault={vault} onDataChange={handleDataChange} error={error} />
            )}
            {selectedOption === 'acquire_expansion' && (
              <AcquireExpansion vault={vault} onDataChange={handleDataChange} error={error} />
            )}

            <div className="mt-8">
              <h4 className="text-lg font-medium mb-4">Voting Period</h4>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center text-sm">
                <div className="flex-1 relative">
                  <LavaDatePicker
                    label={'Start: *'}
                    value={proposalStartDate}
                    onChange={value => setProposalStartDate(new Date(value))}
                    error={error && !proposalStartDate}
                    variant={'steel'}
                  />
                </div>
                <div className="flex-1 relative">
                  <LavaIntervalPicker
                    margin={1}
                    label={'Duration:*'}
                    value={proposalDuration}
                    onChange={value => setProposalDuration(value)}
                    placeholder="Set Voting Period"
                    minMs={MIN_TIME_FOR_VOTING}
                    maxMs={MAX_TIME_FOR_VOTING}
                    error={error && !proposalDuration}
                    variant={'steel'}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ModalWrapper>
      <ConfirmModal
        isOpen={showConfirmation}
        onClose={() => setShowConfirmation(false)}
        onConfirm={handleConfirmCreate}
      />
    </>
  );
};
