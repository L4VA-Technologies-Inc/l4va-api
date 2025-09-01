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

@Injectable()
export class NotificationService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  @InjectRepository(User)
  private readonly userRepository: Repository<User>;

  async sendNotification(body: INotificationBody) {
    const novu = new Novu({
      secretKey: process.env['NOVU_API_KEY'],
    });

    try {
      const res = await novu.trigger({
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
}
