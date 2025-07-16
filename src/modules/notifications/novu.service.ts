import { Injectable, Logger } from '@nestjs/common';
import { Novu } from '@novu/api';
@Injectable()
export class NovuService {
  private readonly logger = new Logger(NovuService.name);
  private novu: Novu;

  constructor() {
    this.novu = new Novu({
      secretKey: process.env.NOVU_API_KEY || '',
    });
  }

  async sendNotification(userId: string, workflowId: string, payload: any, overrides?: any): Promise<void> {
    try {
      await this.novu.trigger({
        workflowId,
        to: userId,
        payload,
        overrides,
      });
    } catch (error) {
      this.logger.error(`Novu notification failed for user ${userId}:`, error.message);
    }
  }

  async sendBulkNotifications(
    events: Array<{
      workflowId: string;
      to: string;
      payload: any;
      overrides?: any;
    }>
  ): Promise<void> {
    try {
      const result = await this.novu.triggerBulk({
        events,
      });

      this.logger.log(`Novu bulk notification sent to ${events.length} users`, {
        bulkResult: result,
      });
    } catch (error) {
      this.logger.error('Novu bulk notification failed:', error.message);
    }
  }

  async createSubscriber(subscriberId: string, email?: string, name?: string): Promise<void> {
    try {
      await this.novu.subscribers.create({
        subscriberId,
        email,
        firstName: name,
      });
      this.logger.log(`Novu subscriber created: ${subscriberId}`);
    } catch (error) {
      this.logger.error(`Novu subscriber creation failed for ${subscriberId}:`, error.message);
    }
  }
}
