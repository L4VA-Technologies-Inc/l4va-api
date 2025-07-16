import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VaultEventsListener } from './listeners/vault-events.listener';
import { MilestoneService } from './milestone.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NovuService } from './novu.service';

import { Notification } from '@/database/notification.entity';
import { User } from '@/database/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Notification, User])],
  controllers: [NotificationsController],
  providers: [NotificationsService, NovuService, VaultEventsListener, MilestoneService],
  exports: [NotificationsService, NovuService, MilestoneService],
})
export class NotificationsModule {}
