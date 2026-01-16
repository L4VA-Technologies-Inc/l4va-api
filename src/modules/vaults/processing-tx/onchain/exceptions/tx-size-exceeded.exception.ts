import { HttpException, HttpStatus } from '@nestjs/common';

export class TxSizeExceededException extends HttpException {
  constructor(
    message: string,
    public readonly maxSize?: number,
    public readonly actualSize?: number
  ) {
    super(message, HttpStatus.BAD_REQUEST);
    this.name = 'TxSizeExceededException';
  }

  static fromErrorMessage(errorMessage: string): TxSizeExceededException {
    const match = errorMessage.match(/Maximum transaction size of (\d+) exceeded\. Found: (\d+)/);

    if (match) {
      const maxSize = parseInt(match[1], 10);
      const actualSize = parseInt(match[2], 10);
      const excess = actualSize - maxSize;

      return new TxSizeExceededException(
        `Transaction size exceeded: maximum ${maxSize} bytes, found ${actualSize} bytes (excess: ${excess} bytes). Unfracking your wallet will reduce the chances of this error.`,
        maxSize,
        actualSize
      );
    }

    return new TxSizeExceededException(
      `Transaction size exceeded. Unfracking your wallet will reduce the chances of this error. ${errorMessage}`,
      undefined,
      undefined
    );
  }
}
