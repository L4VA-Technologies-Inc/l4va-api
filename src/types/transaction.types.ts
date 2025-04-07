
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
  contribute = 'contribute',  // Contains NFTs
  investment = 'investment',  // Contains only lovelace (ADA)
  burn ='burn',
  swap = 'swap',
  stake ='stake'
}
