import { BadRequestException } from '@nestjs/common';

export class InsufficientAssetsException extends BadRequestException {
  constructor(
    public readonly missingAssets: string,
    message?: string
  ) {
    super(
      message ||
        `Insufficient assets in your wallet. ${missingAssets}. ` +
          `Please ensure you have all required assets in your wallet and try again.`
    );
  }
}
