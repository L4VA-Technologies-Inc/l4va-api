import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * What it means: Your transaction inputs don't have enough value to cover all outputs and fees,
 * or there's no single UTxO with the required minimum amount.
 *
 * Two main scenarios:
 * 1. General balance shortage: "Insufficient input in transaction. shortage: {ada in inputs: X, ada in outputs: Y, fee: Z}"
 * 2. Specific UTxO requirement: "No utxo with at least X lovelace"
 *
 * Key requirement: The rule "ada in inputs" must be >= ("ada in outputs" + fee) before adding change.
 *
 * Cardano or Anvil: Cardano-specific (transaction balancing).
 * https://dev.ada-anvil.io/anvil-api/troubleshooting#insufficient-inputs-balance-shortage
 */
export class UTxOInsufficientException extends HttpException {
  constructor(requiredLovelace?: number) {
    const isSpecificUtxoError = requiredLovelace !== undefined;
    const requiredAda = requiredLovelace ? (requiredLovelace / 1_000_000).toFixed(2) : null;

    super(
      {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'UTxO Balance Insufficient',
        message: isSpecificUtxoError
          ? `No single UTxO found with at least ${requiredAda} ADA (${requiredLovelace.toLocaleString()} lovelace). Please consolidate UTxOs or ensure wallet has sufficient balance in individual UTxOs.`
          : 'Not enough UTxO balance to build the transaction',
        code: isSpecificUtxoError ? 'UTXO_MINIMUM_NOT_MET' : 'UTXO_INSUFFICIENT_BALANCE',
        ...(isSpecificUtxoError && {
          requiredLovelace,
          requiredAda,
        }),
        resolution: isSpecificUtxoError
          ? `Ensure your wallet has at least one UTxO containing ${requiredAda} ADA or more. You may need to consolidate smaller UTxOs into a larger one.`
          : 'Please ensure the wallet has enough ADA to cover transaction fees and minimum UTxO requirements',
      },
      HttpStatus.UNPROCESSABLE_ENTITY
    );
  }
}
