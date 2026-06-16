import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ClaimsApiProvider } from './claims';
import { GovernanceApiProvider } from './governance';

import { VaultsApiProvider } from '@/services/api/vaults';
import { TransactionsApiProvider } from '@/services/api/transactions';
import { StakeApiProvider } from '@/services/api/stake';
import { CoreApiProvider } from '@/services/api/core';
import { TapToolsApiProvider } from '@/services/api/taptools';
import { PresetsApiProvider } from '@/services/api/presets/index.js';
import { SettingsApiProvider } from '@/services/api/settings/index.js';
import { RewardsApiProvider } from '@/services/api/rewards/index.js';

export const useVaults = (filters: any) => {
  return useQuery({
    queryKey: ['vaults', filters],
    queryFn: () => {
      return VaultsApiProvider.getVaults(filters);
    },
    staleTime: 0,
  });
};

export const useAcquire = () => {
  return useQuery({
    queryKey: ['acquire'],
    queryFn: () => VaultsApiProvider.getAcquire(),
  });
};

export const useStatistics = () => {
  return useQuery({
    queryKey: ['statistics'],
    queryFn: () => VaultsApiProvider.getStatistics(),
  });
};

export const useMyDraftVaults = () => {
  return useQuery({
    queryKey: ['vaults', 'draft'],
    queryFn: () => VaultsApiProvider.getMyDraftVaults(),
  });
};

export const useMyOpenVaults = () => {
  return useQuery({
    queryKey: ['vaults', 'open'],
    queryFn: () => VaultsApiProvider.getMyOpenVaults(),
  });
};

export const useMyLockedVaults = () => {
  return useQuery({
    queryKey: ['vaults', 'locked'],
    queryFn: () => VaultsApiProvider.getMyLockedVaults(),
  });
};

export const useVault = (id: string) => {
  return useQuery({
    queryKey: ['vault', id],
    queryFn: () => VaultsApiProvider.getVault(id),
    enabled: !!id,
  });
};

export const useVaultAssets = (
  id: string,
  search = '',
  page = 1,
  limit = 10,
  filter: { policyId?: string; type?: string; contributorWalletAddress?: string } = {}
) => {
  return useQuery({
    queryKey: ['vault-assets', id, search, page, limit, filter],
    queryFn: () => VaultsApiProvider.getVaultAssets(id, search, page, limit, filter),
    enabled: !!id,
  });
};

export const useVaultAcquiredAssets = (
  id: string,
  page = 1,
  limit = 10,
  search = '',
  minQuantity?: number,
  maxQuantity?: number
) => {
  return useQuery({
    queryKey: ['vault-acquired-assets', id, page, limit, search, minQuantity, maxQuantity],
    queryFn: () => VaultsApiProvider.getVaultAcquiredAssets(id, page, limit, search, minQuantity, maxQuantity),
    enabled: !!id,
  });
};

// Vault Mutations
export const useCreateVault = () => {
  return useMutation({
    mutationFn: vaultData => VaultsApiProvider.createVault(vaultData),
  });
};

export const useSaveDraft = () => {
  return useMutation({
    mutationFn: vaultData => VaultsApiProvider.saveDraft(vaultData),
  });
};

export const useLaunchVault = () => {
  return useMutation({
    mutationFn: vaultData => VaultsApiProvider.launchVault(vaultData),
  });
};

// Transaction Mutations
export const useBuildTransaction = () => {
  return useMutation({
    mutationFn: params => TransactionsApiProvider.buildTransaction(params),
  });
};

export const useSubmitTransaction = () => {
  return useMutation({
    mutationFn: params => TransactionsApiProvider.submitTransaction(params),
  });
};

// Stake mutations
export const useBuildStakeTx = () => {
  return useMutation({
    mutationFn: (params: { userAddress: string; tokens: { assetId: string; amount: number }[] }) =>
      StakeApiProvider.buildStake(params),
  });
};

export const useBuildUnstakeTx = () => {
  return useMutation({
    mutationFn: (params: { userAddress: string; utxos: { txHash: string; outputIndex: number }[] }) =>
      StakeApiProvider.buildUnstake(params),
  });
};

export const useBuildHarvestTx = () => {
  return useMutation({
    mutationFn: (params: { userAddress: string; utxos: { txHash: string; outputIndex: number }[] }) =>
      StakeApiProvider.buildHarvest(params),
  });
};

export const useBuildCompoundTx = () => {
  return useMutation({
    mutationFn: (params: { userAddress: string; utxos: { txHash: string; outputIndex: number }[] }) =>
      StakeApiProvider.buildCompound(params),
  });
};

export const useSubmitStakeTx = () => {
  return useMutation({
    mutationFn: (params: { transactionId: string; txCbor: string; signature: string }) =>
      StakeApiProvider.submit(params),
  });
};

export type StakedBoxItem = {
  txHash: string;
  outputIndex: number;
  unit: string;
  policyId: string;
  stakedAmount: number;
  stakedAt: number;
  estimatedReward: number;
  estimatedPayout: number;
  eligible: boolean;
  cooldownEndsAt: number;
};

const parseStakedBoxesPayload = (body: unknown): StakedBoxItem[] => {
  // Supported backend shapes:
  // - [ ...boxes ]  (array directly)
  // - { data: [ ...boxes ] }
  // - { boxes: [ ...boxes ] } / { data: { boxes: [ ...boxes ] } }
  const root = (body as { data?: unknown })?.data ?? body;

  if (Array.isArray(root)) return root as StakedBoxItem[];

  const boxesRaw = (root as { boxes?: unknown })?.boxes;
  if (Array.isArray(boxesRaw)) return boxesRaw as StakedBoxItem[];

  // common wrapper: { success: true, data: [...] } already handled above,
  // but also tolerate: { success: true, data: { data: [...] } } or nested.
  const nestedData = (root as { data?: unknown })?.data;
  if (Array.isArray(nestedData)) return nestedData as StakedBoxItem[];
  const nestedBoxes = (nestedData as { boxes?: unknown } | undefined)?.boxes;
  if (Array.isArray(nestedBoxes)) return nestedBoxes as StakedBoxItem[];

  return [];
};

export const useMyStakedBalance = () => {
  return useQuery({
    queryKey: ['stake', 'balance'],
    queryFn: async () => {
      const res = await StakeApiProvider.getMyStakedBalance();
      return parseStakedBoxesPayload(res.data);
    },
    enabled: !!localStorage.getItem('jwt'),
  });
};

export const useTransactions = (params: { page: number; limit: number; filter: string }) => {
  return useQuery({
    queryKey: ['transactions', JSON.stringify(params)],
    queryFn: () => TransactionsApiProvider.getUserTransactions(params),
  });
};

// Contribute Mutations
export const useCreateContributionTx = () => {
  return useMutation({
    mutationFn: ({ vaultId, assets }: { vaultId: string; assets: any[] }) =>
      CoreApiProvider.createContributionTx({ vaultId, assets }),
  });
};

export const useUpdateTransactionHash = () => {
  return useMutation({
    mutationFn: ({ txId, txHash }: { txId: string; txHash: string }) =>
      CoreApiProvider.updateTransactionHash({ txId, txHash }),
  });
};

// Core Queries
export const useProfile = () => {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => CoreApiProvider.getProfile(),
    enabled: !!localStorage.getItem('jwt'),
  });
};

export const usePublicProfile = (userId: string) => {
  return useQuery({
    queryKey: ['profile', userId],
    queryFn: () => CoreApiProvider.getPublicProfile(userId),
    enabled: !!userId,
  });
};

// Core Mutations
export const useLogin = () => {
  return useMutation({
    mutationFn: (credentials: { signature: string; stakeAddress: string; walletAddress: string }) =>
      CoreApiProvider.login(credentials),
  });
};

export const useUpdateProfile = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: profileData => CoreApiProvider.updateProfile(profileData),
    onSuccess: response => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      if (response?.data) {
        queryClient.setQueryData(['profile'], response);
      }
    },
  });
};

export const useUploadImage = () => {
  return useMutation({
    mutationFn: file => CoreApiProvider.uploadImage(file),
  });
};

export const useUploadProfileImage = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ file, imageType }: { file: File; imageType: 'avatar' | 'banner' }) =>
      CoreApiProvider.uploadProfileImage(file, imageType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
};

export const useHandleCsv = () => {
  return useMutation({
    mutationFn: file => CoreApiProvider.handleCsv(file),
  });
};

export const useCreateAcquireTx = () => {
  return useMutation({
    mutationFn: ({ vaultId, assets }: { vaultId: string; assets: any[] }) =>
      CoreApiProvider.acquireAda({ vaultId, assets }),
  });
};

export const useWalletSummaryPaginated = ({
  address,
  page = 1,
  limit = 20,
  filter = 'all',
  whitelistedPolicies,
  search,
  vaultId,
}: {
  address: string;
  page?: number;
  limit?: number;
  filter?: 'all' | 'nfts' | 'tokens';
  whitelistedPolicies?: string[];
  search?: string;
  vaultId?: string;
}) => {
  return useQuery({
    queryKey: ['wallet-summary', address, page, limit, filter, whitelistedPolicies, search, vaultId],
    queryFn: () =>
      TapToolsApiProvider.getWalletSummaryPaginated({
        address,
        page,
        limit,
        filter,
        whitelistedPolicies,
        search,
        vaultId,
      }),
    enabled: !!address,
  });
};

// Claims Queries
export const useClaims = (params: any) => {
  return useQuery({
    queryKey: ['vault-claims', JSON.stringify(params)],
    queryFn: () => ClaimsApiProvider.getClaims(params),
  });
};
// Termination Claims Queries
export const useTerminationStatus = (vaultId: string) => {
  return useQuery({
    queryKey: ['termination-status', vaultId],
    queryFn: () => ClaimsApiProvider.getTerminationStatus(vaultId),
    enabled: !!vaultId,
  });
};

// Termination Claims Mutations
export const useBuildTerminationClaim = () => {
  return useMutation({
    mutationFn: (claimId: string) => ClaimsApiProvider.buildTerminationClaim(claimId),
  });
};

export const useSubmitTerminationClaim = () => {
  return useMutation({
    mutationFn: params => ClaimsApiProvider.submitTerminationClaim(params),
  });
};

export const useGovernanceProposals = (vaultId: string) => {
  return useQuery({
    queryKey: ['governance-proposals', vaultId],
    queryFn: () => GovernanceApiProvider.getProposals(vaultId),
    enabled: !!vaultId,
  });
};

export const useGovernanceProposal = (proposalId: string) => {
  return useQuery({
    queryKey: ['governance-proposal', proposalId],
    queryFn: () => GovernanceApiProvider.getProposal(proposalId),
    enabled: !!proposalId,
  });
};

export const useDeleteProposal = () => {
  return useMutation({
    mutationFn: (proposalId: string) => GovernanceApiProvider.deleteProposal(proposalId),
  });
};

export const useVotingPower = (vaultId: string) => {
  return useQuery({
    queryKey: ['voting-power', vaultId],
    queryFn: () => GovernanceApiProvider.getVotingPower(vaultId),
    enabled: !!vaultId,
    retry: false,
  });
};

export const useVaultAssetsForProposalByType = (vaultId: string, type: any) => {
  return useQuery({
    queryKey: ['vault-assets', vaultId, type],
    queryFn: () => GovernanceApiProvider.getAssets(vaultId, type),
    enabled: !!vaultId && !!type,
  });
};

export const useMarketAssets = (vaultId: string, type: 'unlist' | 'update-listing') => {
  return useQuery({
    queryKey: ['market-assets', vaultId, type],
    queryFn: () => GovernanceApiProvider.getAssets(vaultId, type),
    enabled: !!vaultId && !!type,
  });
};

export const useSwappableAssets = (vaultId: string) => {
  return useQuery({
    queryKey: ['swappable-assets', vaultId],
    queryFn: () => GovernanceApiProvider.getSwappableAssets(vaultId),
    enabled: !!vaultId,
  });
};

export const useAssetMetadata = (unit: string, enabled: boolean = true) => {
  return useQuery({
    queryKey: ['asset-metadata', unit],
    queryFn: () => GovernanceApiProvider.getAssetMetadata(unit),
    enabled: enabled && !!unit && unit.length >= 56,
    retry: 1,
    staleTime: 1000 * 60 * 60, // 1 hour - asset metadata rarely changes
  });
};

export const useOffersToCancel = (vaultId: string, { limit = 20, search = '' } = {}) => {
  const trimmedSearch = typeof search === 'string' ? search.trim() : '';

  return useInfiniteQuery({
    queryKey: ['offers-to-cancel', vaultId, limit, trimmedSearch],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const response = await GovernanceApiProvider.getOffersToCancel(vaultId, {
        page: pageParam,
        limit,
        search: trimmedSearch || undefined,
      });
      const payload = response?.data;

      return {
        items: Array.isArray(payload?.items) ? payload.items : [],
        totalPages: Number(payload?.totalPages) || 1,
        page: Number(payload?.page) || Number(pageParam) || 1,
      };
    },
    getNextPageParam: lastPage => {
      if (lastPage.page < lastPage.totalPages) {
        return lastPage.page + 1;
      }
      return undefined;
    },
    enabled: !!vaultId,
  });
};

export const useCreateProposal = () => {
  return useMutation({
    mutationFn: ({ vaultId, proposalData }: { vaultId: string; proposalData: any }) =>
      GovernanceApiProvider.createProposal(vaultId, proposalData),
  });
};

export const useVoteOnProposal = () => {
  return useMutation({
    mutationFn: ({ proposalId, voteData }: { proposalId: string; voteData: any }) =>
      GovernanceApiProvider.voteOnProposal(proposalId, voteData),
  });
};

export const useGovernanceFees = () => {
  return useQuery({
    queryKey: ['governance-fees'],
    queryFn: () => GovernanceApiProvider.getGovernanceFees(),
  });
};

export const useBuildVoteFeeTransaction = () => {
  return useMutation({
    mutationFn: ({ proposalId, data }: { proposalId: string; data: any }) =>
      GovernanceApiProvider.buildVoteFeeTransaction(proposalId, data),
  });
};

export const useSubmitProposalFeePayment = () => {
  return useMutation({
    mutationFn: ({
      proposalId,
      transaction,
      signatures,
    }: {
      proposalId: string;
      transaction: string;
      signatures: string[];
    }) => GovernanceApiProvider.submitProposalFeePayment(proposalId, { transaction, signatures }),
  });
};

export const useViewVault = () => {
  return useMutation({
    mutationFn: (vaultId: string) => VaultsApiProvider.viewVault(vaultId),
  });
};

export const useBuildBurnTransaction = ({ id }: { id: string }) => {
  return useMutation({
    mutationFn: () => VaultsApiProvider.buildBurnTransaction(id),
  });
};

export const usePublishBurnTransaction = ({ id, payload }: { id: string; payload: any }) => {
  return useMutation({
    mutationFn: () => VaultsApiProvider.publishBurnTransaction(id, payload),
  });
};

export const usePresets = () => {
  return useQuery({
    queryKey: ['presets'],
    queryFn: () => PresetsApiProvider.getAllPresets(),
  });
};

export const useCreatePreset = () => {
  return useMutation({
    mutationFn: payload => PresetsApiProvider.createPreset(payload),
  });
};

export const useDeletePreset = () => {
  return useMutation({
    mutationFn: presetId => PresetsApiProvider.deletePreset(presetId),
  });
};

export const useMarketWithOHLCV = (vaultId: string, interval: string = '1d') => {
  return useQuery({
    queryKey: ['markets', 'ohlcv', vaultId, interval],
    queryFn: () => VaultsApiProvider.getMarketByIdWithOHLCV(vaultId, interval),
    enabled: !!vaultId,
  });
};

export const useMarketStatistics = (params = {}) => {
  return useQuery({
    queryKey: ['vaults', 'market-statistics', params],
    queryFn: () => VaultsApiProvider.getMarketStatistics(params),
    staleTime: 0,
  });
};

export const useVaultActivity = (
  vaultId: string,
  params: { page?: number; limit?: number; sortOrder?: string; filter?: string }
) => {
  return useQuery({
    queryKey: ['vault-activity', vaultId, params],
    queryFn: () => VaultsApiProvider.getVaultActivity(vaultId, params),
    enabled: !!vaultId,
  });
};

export const useVaultAssetsWhitelist = ({ myVaults = false, limit = 10, search = '' } = {}) => {
  return useInfiniteQuery({
    queryKey: ['vaults', 'assets-whitelist', myVaults, limit, search],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const response = await VaultsApiProvider.getAssetsWhitelist({
        myVaults,
        page: pageParam,
        limit,
        search,
      });
      const payload = response?.data;
      return {
        items: Array.isArray(payload?.items) ? payload.items : [],
        totalPages: Number(payload?.totalPages) || 1,
        page: Number(payload?.page) || Number(pageParam) || 1,
      };
    },
    getNextPageParam: lastPage => {
      if (lastPage.page < lastPage.totalPages) {
        return lastPage.page + 1;
      }
      return undefined;
    },
  });
};

export const useVlrmFeeSettings = () => {
  return useQuery({
    queryKey: ['vlrm-fee-settings'],
    queryFn: () => SettingsApiProvider.getVlrmFeeSettings(),
    staleTime: 5 * 60 * 1000,
    retry: 2,
  });
};

export const useTrackWidgetSwap = () => {
  return useMutation({
    mutationFn: (payload: unknown) => RewardsApiProvider.trackWidgetSwap(payload),
  });
};
