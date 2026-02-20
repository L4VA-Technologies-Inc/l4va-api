export enum ClaimStatus {
  /** Available for claiming manually */
  AVAILABLE = 'available',
  /** Claim is pending and waiting for processing */
  PENDING = 'pending',
  /** Claim has been successfully processed */
  CLAIMED = 'claimed',
  /** Claim processing failed */
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
  EXPANSION = 'expansion',
}
