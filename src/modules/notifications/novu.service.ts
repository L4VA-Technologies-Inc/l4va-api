import { Injectable } from '@nestjs/common';
import { Novu } from '@novu/api';

@Injectable()
export class NovuService {
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
      console.error('Novu notification failed:', error);
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
      await this.novu.triggerBulk({
        events,
      });
    } catch (error) {
      console.error('Novu bulk notification failed:', error);
    }
  }

  async createSubscriber(subscriberId: string, email?: string, firstName?: string, lastName?: string): Promise<void> {
    try {
      await this.novu.subscribers.create({
        subscriberId,
        email,
        firstName,
        lastName,
      });
    } catch (error) {
      console.error('Novu subscriber creation failed:', error);
    }
  }
}
