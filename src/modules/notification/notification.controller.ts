import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../auth/auth.guard';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { INotificationBody, NotificationService } from '@/modules/notification/notification.service';

@ApiTags('send-notification')
@Controller('send-notification')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @ApiDoc({
    summary: 'Send notification',
    description: 'Sends notifications to the wallet address',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('')
  async sendNotification(@Body() body: INotificationBody) {
    return this.notificationService.sendNotification(body);
  }
}
