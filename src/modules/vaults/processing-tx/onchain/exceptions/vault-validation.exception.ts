import { BadRequestException } from '@nestjs/common';

export class VaultValidationException extends BadRequestException {
  constructor(message?: string) {
    const defaultMessage = 'Validation error on vault during transaction building.';

    super(message || defaultMessage, 'VAULT_VALIDATION_ERROR');
    this.name = 'VaultValidationException';
  }
}
