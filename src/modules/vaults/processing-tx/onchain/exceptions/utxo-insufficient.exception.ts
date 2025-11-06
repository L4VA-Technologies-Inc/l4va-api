import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * What it means: Your transaction inputs don't have enough value to cover all outputs and fees.
 * The error typically shows: "Insufficient input in transaction. shortage: {ada in inputs: X, ada in outputs: Y, fee: Z}".
 *
 * Key requirement: The rule "ada in inputs" must be >= ("ada in outputs" + fee) before adding change.
 *
 * Cardano or Anvil: Cardano-specific (transaction balancing).
 * https://dev.ada-anvil.io/anvil-api/troubleshooting#insufficient-inputs-balance-shortage
 */
export class UTxOInsufficientException extends HttpException {
  constructor(message?: string) {
    super(
      {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'UTxO Balance Insufficient',
        message: message || 'Not enough UTxO balance to build the transaction',
        code: 'UTXO_INSUFFICIENT_BALANCE',
        resolution: 'Please ensure the wallet has enough ADA to cover transaction fees and minimum UTxO requirements',
      },
      HttpStatus.UNPROCESSABLE_ENTITY
    );
  }
}
