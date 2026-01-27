export enum ClaimStatus {
  AVAILABLE = 'available',
  PENDING = 'pending',
  CLAIMED = 'claimed',
  FAILED = 'failed',
}

export enum ClaimType {
  LP = 'lp',
  CONTRIBUTOR = 'contributor',
  ACQUIRER = 'acquirer',
  L4VA = 'l4va',
  FINAL_DISTRIBUTION = 'final_distribution',
  CANCELLATION = 'cancellation',
  DISTRIBUTION = 'distribution',
  TERMINATION = 'termination',
}
