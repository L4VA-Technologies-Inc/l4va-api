import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { NotificationService } from "@/modules/notification/notification.service";
import { NotificationController } from "@/modules/notification/notification.controller";
import {NotificationEventsListener} from "@/modules/notification/listeners/notification-events.listener";
import {TypeOrmModule} from "@nestjs/typeorm";
import {User} from "@/database/user.entity";

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([User])],
  controllers: [NotificationController],
  providers: [NotificationService,NotificationEventsListener],
  exports: [NotificationService],
})
export class NotificationModule {}
