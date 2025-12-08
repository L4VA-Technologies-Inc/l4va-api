import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * What it means: This error combo occurs when one of the UTXO inputs you included is not actually available to spend.
 * BadInputsUTxO means the transaction is referencing an input that the ledger finds invalid – typically because it's already spent (or doesn't exist).
 *
 * Cardano or Anvil: Cardano-specific (UTXO set validation). Anvil just surfaces it.
 * https://dev.ada-anvil.io/anvil-api/troubleshooting#using-a-spent-or-invalid-utxo-badinputsutxo-valuenotconservedutxo
 */
export class MissingUtxoException extends HttpException {
  public readonly fullTxHash?: string;
  public readonly outputIndex?: number;

  constructor(txHash?: string, index?: number) {
    const txReference = txHash
      ? `${txHash?.substring(0, 4)}...${txHash?.substring(txHash.length - 4)}${index !== undefined ? `#${index}` : ''}`
      : 'Unknown';

    const fullReference = txHash && index !== undefined ? `${txHash}#${index}` : txHash || 'Unknown';

    super(
      {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Missing UTxO Reference',
        message: `The transaction references a UTxO that doesn't exist or has already been spent: ${txReference}`,
        code: 'MISSING_UTXO_REFERENCE',
        fullTxHash: txHash,
        outputIndex: index,
        utxoReference: fullReference,
        resolution: 'Please refresh the UTxO set and try again with updated transaction inputs',
      },
      HttpStatus.UNPROCESSABLE_ENTITY
    );

    this.fullTxHash = txHash;
    this.outputIndex = index;
  }

  /**
   * Get the full UTXO reference as string
   */
  getUtxoReference(): string {
    if (this.fullTxHash && this.outputIndex !== undefined) {
      return `${this.fullTxHash}#${this.outputIndex}`;
    }
    return this.fullTxHash || 'Unknown';
  }

  /**
   * Get structured UTXO data
   */
  getUtxoData(): { txHash?: string; index?: number; reference: string } {
    return {
      txHash: this.fullTxHash,
      index: this.outputIndex,
      reference: this.getUtxoReference(),
    };
  }
}
