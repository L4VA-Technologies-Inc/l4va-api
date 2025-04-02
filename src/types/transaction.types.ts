
export enum TransactionStatus {
  created = 'created',
  pending = 'pending',
  submitted ='submitted',
  confirmed = 'confirmed',
  failed = 'failed',
  stuck = 'stuck'
}

export enum TransactionType {
  mint = 'mint',
  payment = 'payment',
  contribute = 'contribute',
  burn ='burn',
  swap = 'swap',
  stake ='stake'
}
