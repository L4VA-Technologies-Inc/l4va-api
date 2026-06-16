export class GovernanceConfigProvider {
  static getProposals(vaultId) {
    return `/api/v1/governance/vaults/${vaultId}/proposals`;
  }

  static createProposal(vaultId) {
    return `/api/v1/governance/vaults/${vaultId}/proposals`;
  }

  static getProposal(proposalId) {
    return `/api/v1/governance/proposals/${proposalId}`;
  }

  static deleteProposal(proposalId) {
    return `/api/v1/governance/proposals/${proposalId}`;
  }

  static voteOnProposal(proposalId) {
    return `/api/v1/governance/proposals/${proposalId}/vote`;
  }

  static getVotingPower(vaultId) {
    return `/api/v1/governance/vaults/${vaultId}/voting-power`;
  }

  static getAssets(vaultId, type) {
    return `/api/v1/governance/vaults/${vaultId}/assets/${type}`;
  }

  static getSwappableAssets(vaultId) {
    return `/api/v1/governance/vaults/${vaultId}/swappable-assets`;
  }

  static getAssetMetadata(unit) {
    return `/api/v1/governance/assets/metadata/${unit}`;
  }

  static getOffersToCancel(vaultId) {
    return `/api/v1/governance/vaults/${vaultId}/offers-to-cancel`;
  }

  static getGovernanceFees() {
    return `/api/v1/governance/governance-fees`;
  }

  static buildVoteFeeTransaction(proposalId) {
    return `/api/v1/governance/proposals/${proposalId}/vote-fee-transaction`;
  }

  static submitProposalFeePayment(proposalId) {
    return `/api/v1/governance/proposals/${proposalId}/submit-fee-payment`;
  }
}
