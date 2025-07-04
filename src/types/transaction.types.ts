export enum TransactionStatus {
  created = 'created',
  pending = 'pending',
  submitted = 'submitted',
  confirmed = 'confirmed',
  failed = 'failed',
  stuck = 'stuck',
}

export enum TransactionType {
  mint = 'mint',
  payment = 'payment',
  contribute = 'contribute', // Contains NFTs
  claim = 'claim',
  acquire = 'acquire', // Contains only lovelace (ADA)
  investment = 'investment',
  burn = 'burn',
  swap = 'swap',
  stake = 'stake',
  extractLp = 'extract-lp',
  distributeLp = 'distribute-lp',
  updateVault = 'update-vault', // Vault metadata update transaction
}
