import { Module } from '@nestjs/common';

import { PresaleReminderService } from './presale-reminder.service';
import { PresaleController } from './presale.controller';
import { PresaleService } from './presale.service';

import { NotificationModule } from '@/modules/notification/notification.module';
import { RedisModule } from '@/modules/redis/redis.module';

@Module({
  imports: [NotificationModule, RedisModule],
  controllers: [PresaleController],
  providers: [PresaleService, PresaleReminderService],
  exports: [PresaleService],
})
export class PresaleModule {}
