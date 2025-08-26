import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { NotificationService } from "@/modules/notification/notification.service";
import { NotificationController } from "@/modules/notification/notification.controller";

@Module({
  imports: [HttpModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
