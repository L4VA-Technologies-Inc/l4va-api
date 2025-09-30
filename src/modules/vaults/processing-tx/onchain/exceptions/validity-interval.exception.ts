import { BadRequestException } from '@nestjs/common';

export class ValidityIntervalException extends BadRequestException {
  constructor(
    public readonly invalidBefore?: number,
    public readonly invalidHereafter?: number,
    public readonly currentSlot?: number,
    message?: string
  ) {
    const defaultMessage =
      `Transaction validity interval error. ` +
      `Current slot: ${currentSlot}, ` +
      `Valid from: ${invalidBefore || 'N/A'}, ` +
      `Valid until: ${invalidHereafter || 'N/A'}`;

    super(message || defaultMessage, 'VALIDITY_INTERVAL_ERROR');
    this.name = 'ValidityIntervalException';
  }

  getValidityWindow(): { from?: number; to?: number; current?: number } {
    return {
      from: this.invalidBefore,
      to: this.invalidHereafter,
      current: this.currentSlot,
    };
  }

  isExpired(): boolean {
    if (!this.currentSlot || !this.invalidHereafter) return false;
    return this.currentSlot > this.invalidHereafter;
  }

  isNotYetValid(): boolean {
    if (!this.currentSlot || !this.invalidBefore) return false;
    return this.currentSlot < this.invalidBefore;
  }
}
