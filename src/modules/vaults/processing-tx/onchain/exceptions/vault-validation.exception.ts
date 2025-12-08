import { BadRequestException } from '@nestjs/common';

/**
 * What it means: The transaction failed on-chain validation due to smart contract constraints not being met.
 * Common reasons include incorrect datum, missing required signatures, or invalid redeemers, or contribution window violations.
 *
 * Cardano or Anvil or Smart Contract: Smart Contract-specific (on-chain validation failure).
 */
export class VaultValidationException extends BadRequestException {
  constructor(message?: string) {
    const defaultMessage = 'Transaction validation failed due to smart contract constraints.';

    super(message || defaultMessage, 'VAULT_VALIDATION_ERROR');
    this.name = 'VaultValidationException';
  }
}
