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
    if (!bulkOptions || !Array.isArray(bulkOptions) || bulkOptions.length === 0) {
      this.logger.warn('Bulk options are empty or invalid. No notifications will be sent.');
      return;
    }

    const users = await this.userRepository.findBy({
      id: In(bulkOptions),
    });

    if (users.length === 0) {
      this.logger.warn('No valid users found for bulk notification.');
      return;
    }

    await Promise.all(
      users.map(async user => {
        if (!user.address) {
          return;
        }
        await this.sendNotification({ ...body, address: user.address });
      })
    );
  }

  async sendFailedEmailNotification(body: IEmailNotificationBody): Promise<EventsControllerTriggerResponse> {
    try {
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
        },
      });
      return res;
    } catch (err) {
      return err;
    }
  }

  async sendPhaseEmailNotification(body: any): Promise<EventsControllerTriggerResponse> {
    try {
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
        },
      });
      return res;
    } catch (err) {
      return err;
    }
  }

  async sendLaunchEmailNotification(body: any): Promise<EventsControllerTriggerResponse> {
    try {
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
        },
      });
      return res;
    } catch (err) {
      return err;
    }
  }
}
