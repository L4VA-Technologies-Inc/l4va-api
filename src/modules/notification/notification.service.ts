import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Novu } from '@novu/api';
import { Repository } from 'typeorm';

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
  failed_at: Date;
  vaultName: string;
}

@Injectable()
export class NotificationService {

  private readonly novu: Novu;

  constructor(
    private readonly eventEmitter: EventEmitter2
  ) {
    this.novu = new Novu({
      secretKey: process.env['NOVU_API_KEY'],
    });
  }

  @InjectRepository(User)
  private readonly userRepository: Repository<User>;

  async sendNotification(body: INotificationBody) {
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

  async sendBulkNotification(body: INotificationBody, bulkOptions: string[]) {
    await Promise.all(
      bulkOptions.map(async item => {
        const { address } = await this.userRepository.findOneBy({ id: item });
        body.address = address;
        await this.sendNotification({ ...body });
      })
    );
  }

  async sendFailedEmailNotification(body: IEmailNotificationBody) {
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
}
