import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SlackAlertData {
  [key: string]: any;
}

export type SlackAlertType = 'asset_price_fetch_failed' | 'wallet_fetch_failed' | 'general_error' | string;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly slackWebhookUrl: string;
  private readonly slackChannel: string;
  private readonly SLACK_ALERT_COOLDOWN = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
  private lastSlackAlert = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {
    this.slackWebhookUrl = this.configService.get<string>('SLACK_BOT_TOKEN');
    this.slackChannel = `#${this.configService.get<string>('SLACK_CHANNEL')}`;
  }

  /**
   * Send Slack alert with rate limiting to prevent spam
   * @param alertType Type of alert (used for cooldown tracking)
   * @param data Alert data to include in the message
   */
  async sendAlert(alertType: SlackAlertType, data: SlackAlertData): Promise<void> {
    try {
      if (!this.slackWebhookUrl) {
        this.logger.debug('Slack webhook URL not configured, skipping alert');
        return;
      }

      // Check cooldown
      const lastAlertTime = this.lastSlackAlert.get(alertType) || 0;
      const now = Date.now();

      if (now - lastAlertTime < this.SLACK_ALERT_COOLDOWN) {
        this.logger.debug(`Slack alert for ${alertType} is on cooldown`);
        return;
      }

      // Format and send message
      const message = this.formatSlackMessage(alertType, data);

      await axios.post(
        this.slackWebhookUrl,
        {
          channel: this.slackChannel,
          ...message,
        },
        {
          timeout: 5000,
        }
      );

      // Update last alert time
      this.lastSlackAlert.set(alertType, now);
      this.logger.log(`Slack alert sent for ${alertType}`);
    } catch (error) {
      this.logger.error(`Failed to send Slack alert: ${error.message}`);
    }
  }

  /**
   * Format Slack message with rich formatting
   * @param alertType Type of alert
   * @param data Alert data
   * @returns Formatted Slack message object
   */
  private formatSlackMessage(
    alertType: SlackAlertType,
    data: SlackAlertData
  ): {
    text: string;
    blocks: any[];
  } {
    const timestamp = new Date().toLocaleString();

    switch (alertType) {
      case 'asset_price_fetch_failed':
        return {
          text: `⚠️ Asset Price Fetch Failed`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '⚠️ Asset Price Fetch Failed',
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Policy ID:*\n${data.policyId}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Asset Name:*\n${data.assetName}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Error:*\n${data.error}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Timestamp:*\n${timestamp}`,
                },
              ],
            },
          ],
        };

      case 'wallet_fetch_failed':
        return {
          text: `⚠️ Wallet Data Fetch Failed`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '⚠️ Wallet Data Fetch Failed',
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Wallet Address:*\n${data.walletAddress}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Error:*\n${data.error}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Timestamp:*\n${timestamp}`,
                },
              ],
            },
          ],
        };

      case 'general_error':
        return {
          text: `🚨 General Error`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🚨 General Error',
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Service:*\n${data.service || 'Unknown'}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Error:*\n${data.error}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Details:*\n${data.details || 'N/A'}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Timestamp:*\n${timestamp}`,
                },
              ],
            },
          ],
        };

      default:
        return {
          text: `📢 Alert: ${alertType}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `📢 Alert: ${alertType}`,
                emoji: true,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `\`\`\`${JSON.stringify(data, null, 2)}\`\`\``,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*Timestamp:* ${timestamp}`,
                },
              ],
            },
          ],
        };
    }
  }

  /**
   * Send a custom formatted alert
   * @param title Alert title
   * @param fields Key-value pairs for alert fields
   */
  async sendCustomAlert(title: string, fields: { [key: string]: string }): Promise<void> {
    const timestamp = new Date().toLocaleString();

    try {
      if (!this.slackWebhookUrl) {
        this.logger.debug('Slack webhook URL not configured, skipping alert');
        return;
      }

      const blocks = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: title,
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: Object.entries(fields).map(([key, value]) => ({
            type: 'mrkdwn',
            text: `*${key}:*\n${value}`,
          })),
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `*Timestamp:* ${timestamp}`,
            },
          ],
        },
      ];

      await axios.post(
        this.slackWebhookUrl,
        {
          channel: this.slackChannel,
          text: title,
          blocks,
        },
        {
          timeout: 5000,
        }
      );

      this.logger.log(`Custom Slack alert sent: ${title}`);
    } catch (error) {
      this.logger.error(`Failed to send custom Slack alert: ${error.message}`);
    }
  }
}
