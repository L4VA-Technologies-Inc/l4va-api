import { BadRequestException } from '@nestjs/common';

export class UtxoSpentException extends BadRequestException {
  constructor(
    public readonly txHash: string,
    public readonly outputIndex: number,
    message?: string
  ) {
    super(
      message ||
        `Transaction input ${txHash}#${outputIndex} has already been spent or does not exist. ` +
          `Please refresh your wallet and try again with fresh UTXOs.`
    );
  }
}
