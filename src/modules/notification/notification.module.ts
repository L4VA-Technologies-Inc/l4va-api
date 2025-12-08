import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '@/database/user.entity';
import { NotificationEventsListener } from '@/modules/notification/listeners/notification-events.listener';
import { NotificationService } from '@/modules/notification/notification.service';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([User])],
  controllers: [],
  providers: [NotificationService, NotificationEventsListener],
  exports: [NotificationService],
})
export class NotificationModule {}
