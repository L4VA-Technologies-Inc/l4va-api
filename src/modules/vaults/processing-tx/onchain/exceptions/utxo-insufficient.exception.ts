import { HttpException, HttpStatus } from '@nestjs/common';

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
