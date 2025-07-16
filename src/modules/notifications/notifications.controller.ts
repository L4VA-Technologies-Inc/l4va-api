import { Controller, Get, Delete, Param, Request, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';

import { NotificationsService } from './notifications.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';

@UseGuards(AuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @ApiDoc({
    summary: 'Get all notifications for the authenticated user',
    description: 'Retrieves all notifications and marks them as read for the authenticated user.',
    status: 200,
  })
  @Get()
  async getNotifications(@Request() req) {
    return this.notificationsService.markAllAsReadAndGet(req.user.sub);
  }

  @ApiDoc({
    summary: 'Delete a notification',
    description: 'Deletes a specific notification for the authenticated user.',
    status: 200,
  })
  @Delete(':id')
  async deleteNotification(@Request() req, @Param('id') notificationId: string) {
    await this.notificationsService.deleteNotification(req.user.sub, notificationId);
    return { success: true };
  }
}
