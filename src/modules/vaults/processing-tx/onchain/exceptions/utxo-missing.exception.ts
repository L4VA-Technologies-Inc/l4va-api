import { HttpException, HttpStatus } from '@nestjs/common';

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
