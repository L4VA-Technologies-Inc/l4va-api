/**
 * A passed proposal that can no longer run as voted: the vault changed since the vote (e.g. its
 * free balance no longer covers the amount). Retrying cannot fix it, so the proposal is rejected
 * with this message instead of being retried.
 */
export class ProposalConditionsChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalConditionsChangedError';
  }
}
