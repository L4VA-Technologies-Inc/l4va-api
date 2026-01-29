export enum TransactionStatus {
  created = 'created',
  pending = 'pending',
  submitted = 'submitted',
  confirmed = 'confirmed',
  failed = 'failed',
  stuck = 'stuck',
}

export enum TransactionType {
  createVault = 'create-vault',
  mint = 'mint',
  payment = 'payment',
  contribute = 'contribute', // Contains NFTs
  claim = 'claim',
  extract = 'extract',
  extractDispatch = 'extract-dispatch',
  cancel = 'cancel',
  /** Contains only lovelace (ADA) */
  acquire = 'acquire',
  investment = 'investment',
  burn = 'burn',
  swap = 'swap',
  stake = 'stake',
  extractLp = 'extract-lp',
  distributeLp = 'distribute-lp',
  /** ADA distribution from treasury to VT holders */
  distribution = 'distribution',
  /** Vault metadata update transaction */
  updateVault = 'update-vault',
  /** WayUp marketplace transaction (listing, unlisting, update, offer, purchase) */
  wayup = 'wayup',
  all = 'all',
}
