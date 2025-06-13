import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WebhookVerificationService {
  private readonly logger = new Logger(WebhookVerificationService.name);
  private readonly webhookAuthToken: string;
  private readonly maxEventAge: number;

  constructor(private readonly configService: ConfigService) {
    this.webhookAuthToken = this.configService.get<string>('BLOCKFROST_WEBHOOK_AUTH_TOKEN');
    this.maxEventAge = 600; // 10 minutes max age for webhook events
  }

  verifySignature(payload: string, signatureHeader: string): boolean {
    if (!this.webhookAuthToken) {
      this.logger.error('BLOCKFROST_WEBHOOK_AUTH_TOKEN is not configured');
      throw new Error('BLOCKFROST_WEBHOOK_AUTH_TOKEN is not configured');
    }

    if (!signatureHeader) {
      this.logger.error('blockfrost-signature header is missing');
      throw new Error('blockfrost-signature header is missing');
    }

    try {
      // Parse the signature header
      const [timestampHeader, signatureValue] = signatureHeader.split(',');
      const timestamp = timestampHeader.split('=')[1];
      const signature = signatureValue.split('=')[1];

      // Log parsed values
      this.logger.debug('Parsed signature components:', {
        timestamp,
        signature,
        payloadLength: payload.length,
      });

      // Prepare the signature payload as per Blockfrost docs
      const signaturePayload = `${timestamp}.${payload}`;

      // Compute HMAC
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookAuthToken)
        .update(signaturePayload)
        .digest('hex');

      // Log computed values for debugging
      this.logger.debug('Computed signature:', {
        expectedSignature,
        receivedSignature: signature,
        match: expectedSignature === signature,
      });

      // Verify timestamp is within tolerance
      const currentTime = Math.floor(Date.now() / 1000);
      const timeDiff = Math.abs(currentTime - parseInt(timestamp));

      if (timeDiff > this.maxEventAge) {
        this.logger.error('Webhook event is too old:', {
          eventTime: timestamp,
          currentTime,
          maxAge: this.maxEventAge,
        });
        return false;
      }

      // Compare signatures
      if (expectedSignature === signature) {
        this.logger.log('Webhook signature verified successfully');
        return true;
      }

      this.logger.error('Signature mismatch:', {
        expected: expectedSignature,
        received: signature,
      });
      return false;
    } catch (error) {
      this.logger.error('Error during signature verification:', {
        error: error.message,
        signatureHeader,
      });
      return false;
    }
  }
}
