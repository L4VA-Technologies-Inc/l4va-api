import { BadRequestException } from '@nestjs/common';

export class VaultValidationException extends BadRequestException {
  constructor(message?: string) {
    const defaultMessage = 'Transaction validation failed due to smart contract constraints.';

    super(message || defaultMessage, 'VAULT_VALIDATION_ERROR');
    this.name = 'VaultValidationException';
  }
}
