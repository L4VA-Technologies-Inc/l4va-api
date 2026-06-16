import { GovernanceConfigProvider } from '@/services/api/governance/config';
import { axiosInstance } from '@/services/api';

export class GovernanceApiProvider {
  static async getProposals(vaultId) {
    const response = await axiosInstance.get(GovernanceConfigProvider.getProposals(vaultId));
    return response;
  }

  static async createProposal(vaultId, proposalData) {
    const response = await axiosInstance.post(GovernanceConfigProvider.createProposal(vaultId), proposalData);
    return response;
  }

  static async getProposal(proposalId) {
    const response = await axiosInstance.get(GovernanceConfigProvider.getProposal(proposalId));
    return response;
  }

  static async deleteProposal(proposalId) {
    const response = await axiosInstance.delete(GovernanceConfigProvider.deleteProposal(proposalId));
    return response;
  }

  static async voteOnProposal(proposalId, voteData) {
    const response = await axiosInstance.post(GovernanceConfigProvider.voteOnProposal(proposalId), voteData);
    return response;
  }

  static async getVotingPower(vaultId) {
    try {
      const response = await axiosInstance.get(GovernanceConfigProvider.getVotingPower(vaultId));
      return response;
    } catch (error) {
      const errorMessage = error.response?.data?.message || 'Unknown error occurred';
      throw new Error(errorMessage);
    }
  }

  static async getAssets(vaultId, type) {
    const response = await axiosInstance.get(GovernanceConfigProvider.getAssets(vaultId, type));
    return response;
  }

  static async getSwappableAssets(vaultId) {
    const response = await axiosInstance.get(GovernanceConfigProvider.getSwappableAssets(vaultId));
    return response;
  }

  static async getAssetMetadata(unit) {
    const response = await axiosInstance.get(GovernanceConfigProvider.getAssetMetadata(unit));
    return response;
  }

  static async getOffersToCancel(vaultId, { page = 1, limit = 20, search } = {}) {
    const params = { page, limit };
    const trimmedSearch = typeof search === 'string' ? search.trim() : '';

    if (trimmedSearch) {
      params.search = trimmedSearch;
    }

    const response = await axiosInstance.get(GovernanceConfigProvider.getOffersToCancel(vaultId), {
      params,
    });
    return response;
  }

  static async getGovernanceFees() {
    const response = await axiosInstance.get(GovernanceConfigProvider.getGovernanceFees());
    return response;
  }

  static async buildVoteFeeTransaction(proposalId, data) {
    const response = await axiosInstance.post(GovernanceConfigProvider.buildVoteFeeTransaction(proposalId), data);
    return response;
  }

  static async submitProposalFeePayment(proposalId, data) {
    const response = await axiosInstance.post(GovernanceConfigProvider.submitProposalFeePayment(proposalId), data);
    return response;
  }
}
