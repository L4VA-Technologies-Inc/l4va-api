
export enum TransactionStatus {
  created = 'created',
  pending = 'pending',
  submitted ='submitted',
  confirmed = 'confirmed',
  failed = 'failed',
  manual_review = 'manual-review'
}

export enum TransactionType {
  mint = 'mint',
  payment = 'payment',
  contribute = 'contribute',
  burn ='burn',
  swap = 'swap',
  stake ='stake'
}
