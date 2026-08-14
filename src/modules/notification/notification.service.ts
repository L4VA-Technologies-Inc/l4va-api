import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Novu } from '@novu/api';
import { EventsControllerTriggerResponse } from '@novu/api/models/operations';
import { In, Repository } from 'typeorm';

import { User } from '@/database/user.entity';

export interface INotificationBody {
  address?: string;
  title: string;
  description: string;
  vaultId?: string;
  vaultName?: string;
  contributorIds?: string[];
  tokenHolderIds?: string[];
}

export interface IEmailNotificationBody {
  email: string;
  address: string;
  firstName: string;
  status: string;
  vaultTokenTicker: string;
  vaultUrl: string;
  failed_at: any;
  vaultName: string;
}

@Injectable()
export class NotificationService {
  private readonly novu: Novu;
  private readonly logger = new Logger(NotificationService.name);

  private getEmailFooterPayload(): { currentYear: number; footerCopyright: string; content: string } {
    const currentYear = new Date().getFullYear();
    const footerCopyright = `Copyright © ${currentYear}. All Rights Reserved by L4VA`;
    return {
      currentYear,
      footerCopyright,
      content: footerCopyright,
    };
  }

  constructor() {
    this.novu = new Novu({
      secretKey: process.env['NOVU_API_KEY'],
    });
  }

  @InjectRepository(User)
  private readonly userRepository: Repository<User>;

  async sendNotification(body: INotificationBody): Promise<any> {
    try {
      const res = await this.novu.trigger({
        workflowId: 'l4va',
        to: body.address,
        payload: { ...body },
      });
      return res;
    } catch (err) {
      return err;
    }
  }

  async sendBulkNotification(body: INotificationBody, bulkOptions: string[]): Promise<void> {
    if (!bulkOptions || !Array.isArray(bulkOptions)) {
      this.logger.warn('Bulk options are invalid. No notifications will be sent.');
      return;
    }

    const recipientIds = [...new Set(bulkOptions.filter(id => typeof id === 'string' && id.trim().length > 0))];
    if (recipientIds.length === 0) {
      this.logger.debug('Bulk notification skipped: recipient list is empty.');
      return;
    }

    const users = await this.userRepository.findBy({
      id: In(recipientIds),
    });

    if (users.length === 0) {
      this.logger.warn('No valid users found for bulk notification.');
      return;
    }

    const usersWithAddress = users.filter(user => !!user.address);
    if (usersWithAddress.length === 0) {
      this.logger.warn(
        `Bulk notification skipped: resolved ${users.length} user(s), but none have a wallet address on profile.`
      );
      return;
    }

    if (usersWithAddress.length < users.length) {
      this.logger.debug(
        `Bulk notification: ${users.length - usersWithAddress.length} user(s) skipped due to missing wallet address.`
      );
    }

    await Promise.all(
      usersWithAddress.map(async user => {
        await this.sendNotification({ ...body, address: user.address });
      })
    );
  }

  async sendFailedEmailNotification(body: IEmailNotificationBody): Promise<EventsControllerTriggerResponse> {
    try {
      const footerPayload = this.getEmailFooterPayload();
      const res = await this.novu.trigger({
        workflowId: 'failed',
        to: {
          subscriberId: body.address,
          email: body.email,
        },
        payload: {
          email: body.email,
          firstName: body.firstName,
          status: body.status,
          vaultTokenTicker: body.vaultTokenTicker,
          vaultUrl: body.vaultUrl,
          failed_at: body.failed_at || new Date(),
          vaultName: body.vaultName,
          ...footerPayload,
        },
      });
      return res;
    } catch (err) {
      return err;
    }
  }

  async sendPhaseEmailNotification(body: any): Promise<EventsControllerTriggerResponse> {
    try {
      const footerPayload = this.getEmailFooterPayload();
      const res = await this.novu.trigger({
        workflowId: 'phase',
        to: {
          subscriberId: body.address,
          email: body.email,
        },
        payload: {
          firstName: body.firstName,
          vaultUrl: body.vaultUrl,
          vaultName: body.vaultName,
          phase: body.phase,
          phaseStatus: body.phaseStatus,
          timeAt: body.timeAt,
          ...footerPayload,
        },
      });
      return res;
    } catch (err) {
      return err;
    }
  }

  async sendLaunchEmailNotification(body: any): Promise<EventsControllerTriggerResponse> {
    try {
      const footerPayload = this.getEmailFooterPayload();
      const res = await this.novu.trigger({
        workflowId: 'created',
        to: {
          subscriberId: body.address,
          email: body.email,
        },
        payload: {
          firstName: body.firstName,
          vaultUrl: body.vaultUrl,
          vaultName: body.vaultName,
          timeAt: body.timeAt,
          ...footerPayload,
        },
      });
      return res;
    } catch (err) {
      return err;
    }
  }
}
