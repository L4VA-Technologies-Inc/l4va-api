import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * What it means: This error combo occurs when one of the UTXO inputs you included is not actually available to spend.
 * BadInputsUTxO means the transaction is referencing an input that the ledger finds invalid – typically because it's already spent (or doesn't exist).
 *
 * Cardano or Anvil: Cardano-specific (UTXO set validation). Anvil just surfaces it.
 * https://dev.ada-anvil.io/anvil-api/troubleshooting#using-a-spent-or-invalid-utxo-badinputsutxo-valuenotconservedutxo
 */
export class MissingUtxoException extends HttpException {
  constructor(txHash?: string, index?: number) {
    const txReference = txHash
      ? `${txHash?.substring(0, 4)}...${txHash?.substring(txHash.length - 4)}${index !== undefined ? `#${index}` : ''}`
      : 'Unknown';

    super(
      {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Missing UTxO Reference',
        message: `The transaction references a UTxO that doesn't exist or has already been spent: ${txReference}`,
        code: 'MISSING_UTXO_REFERENCE',
        resolution: 'Please refresh the UTxO set and try again with updated transaction inputs',
      },
      HttpStatus.UNPROCESSABLE_ENTITY
    );
  }
}
