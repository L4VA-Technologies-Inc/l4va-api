import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NovuService } from './novu.service';

import { Notification } from '@/database/notification.entity';
import { User } from '@/database/user.entity';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private novuService: NovuService
  ) {}

  async createNotification(
    userId: string,
    title: string,
    message: string,
    type: string,
    options?: {
      relatedEntityType?: string;
      relatedEntityId?: string;
      actionUrl?: string;
      novuWorkflowId?: string;
      novuPayload?: any;
      sendPush?: boolean;
    }
  ): Promise<void> {
    // 1. Create in-app notification
    const notification = this.notificationRepository.create({
      user_id: userId,
      title,
      message,
      type,
      related_entity_type: options?.relatedEntityType,
      related_entity_id: options?.relatedEntityId,
      action_url: options?.actionUrl,
      is_read: false,
    });

    await this.notificationRepository.save(notification);

    // 2. Update user has_notifications flag
    await this.userRepository.update(userId, { has_notifications: true });

    // 3. Send push notification via Novu if enabled
    if (options?.novuWorkflowId && options?.sendPush !== false) {
      await this.novuService.sendNotification(userId, options.novuWorkflowId, {
        title,
        message,
        actionUrl: options.actionUrl,
        ...options.novuPayload,
      });
    }
  }

  async createBulkNotifications(
    userIds: string[],
    title: string,
    message: string,
    type: string,
    options?: {
      relatedEntityType?: string;
      relatedEntityId?: string;
      actionUrl?: string;
      novuWorkflowId?: string;
      novuPayload?: any;
      sendPush?: boolean;
    }
  ): Promise<void> {
    // 1. Create in-app notifications
    const notifications = userIds.map(userId => ({
      user_id: userId,
      title,
      message,
      type,
      related_entity_type: options?.relatedEntityType,
      related_entity_id: options?.relatedEntityId,
      action_url: options?.actionUrl,
      is_read: false,
    }));

    await this.notificationRepository.save(notifications);

    // 2. Update users has_notifications flag
    await this.userRepository.update(userIds, { has_notifications: true });

    // 3. Send bulk push notifications via Novu if enabled
    if (options?.novuWorkflowId && options?.sendPush !== false) {
      const events = userIds.map(userId => ({
        workflowId: options.novuWorkflowId,
        to: userId,
        payload: {
          title,
          message,
          actionUrl: options.actionUrl,
          ...options.novuPayload,
        },
      }));

      await this.novuService.sendBulkNotifications(events);
    }
  }

  private async getUserNotifications(userId: string): Promise<Notification[]> {
    return this.notificationRepository.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
  }

  async markAllAsReadAndGet(userId: string): Promise<Notification[]> {
    // Get all notifications
    const notifications = await this.getUserNotifications(userId);

    // Mark all as read with timestamp
    await this.notificationRepository.update(
      { user_id: userId, is_read: false },
      { is_read: true, read_at: new Date() }
    );

    // Update user has_notifications flag
    await this.userRepository.update(userId, { has_notifications: false });

    return notifications;
  }

  async deleteNotification(userId: string, notificationId: string): Promise<void> {
    await this.notificationRepository.delete({
      id: notificationId,
      user_id: userId,
    });

    // Check if user still has unread notifications
    const unreadCount = await this.notificationRepository.count({
      where: { user_id: userId, is_read: false },
    });

    if (unreadCount === 0) {
      await this.userRepository.update(userId, { has_notifications: false });
    }
  }
}
