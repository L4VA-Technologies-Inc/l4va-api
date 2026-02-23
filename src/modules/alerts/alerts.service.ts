import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SlackAlertData {
  [key: string]: any;
}

export type SlackAlertType =
  | 'asset_price_fetch_failed'
  | 'wallet_fetch_failed'
  | 'general_error'
  | 'admin_utxos_exhausted'
  | 'expansion_invalid_vtprice'
  | string;

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly slackToken: string;
  private readonly slackChannel: string;
  private readonly SLACK_ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour in milliseconds
  private lastSlackAlert = new Map<string, number>();

  constructor(private readonly configService: ConfigService) {
    this.slackToken = this.configService.get<string>('SLACK_BOT_TOKEN');
    this.slackChannel = `#${this.configService.get<string>('SLACK_CHANNEL')}`;
  }

  /**
   * Send Slack alert with rate limiting to prevent spam
   * @param alertType Type of alert (used for cooldown tracking)
   * @param data Alert data to include in the message
   */
  async sendAlert(alertType: SlackAlertType, data: SlackAlertData): Promise<void> {
    try {
      if (!this.slackToken) {
        this.logger.debug('Slack token not configured, skipping alert');
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

      const response = await axios.post(
        'https://slack.com/api/chat.postMessage',
        {
          channel: this.slackChannel,
          text: message.text,
          blocks: message.blocks,
        },
        {
          headers: {
            Authorization: `Bearer ${this.slackToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000, // 5 second timeout for Slack API
        }
      );

      if (response.data.ok) {
        this.lastSlackAlert.set(alertType, now);
        this.logger.log(`Slack alert sent successfully for ${alertType}`);
      } else {
        this.logger.error(`Failed to send Slack alert: ${response.data.error}`);
      }

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

      case 'admin_utxos_exhausted':
        return {
          text: `🚨 Admin UTXOs Exhausted - Distribution Blocked`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🚨 Admin UTXOs Exhausted',
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Vault ID:*\n\`${data.vaultId}\``,
                },
                {
                  type: 'mrkdwn',
                  text: `*Excluded UTXOs:*\n${data.excludedUtxosCount}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Claims Pending:*\n${data.claimCount}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Retry Attempt:*\n${data.retryAttempt + 1}/3`,
                },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  `*⚠️ Action Required:*\n` +
                  `No valid admin UTXOs available after filtering spent UTXOs. ` +
                  `The distribution system cannot process contributor payments.\n\n` +
                  `*Next Steps:*\n` +
                  `• Check admin wallet for sufficient UTXOs\n` +
                  `• Wait for pending transactions to confirm\n` +
                  `• System will retry in next cron cycle (10 minutes)`,
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

      case 'expansion_invalid_vtprice':
        return {
          text: `🚨 Expansion Invalid VT Price - Manual Review Required`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🚨 Expansion Invalid VT Price',
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Vault ID:*\n\`${data.vaultId}\``,
                },
                {
                  type: 'mrkdwn',
                  text: `*Proposal ID:*\n\`${data.proposalId}\``,
                },
                {
                  type: 'mrkdwn',
                  text: `*Invalid VT Price:*\n${data.vtPrice}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Price Type:*\n${data.priceType}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Limit Price:*\n${data.limitPrice || 'N/A'}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Vault VT Price:*\n${data.vaultVtPrice || 'N/A'}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Claims Created:*\n${data.claimCount}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Assets Contributed:*\n${data.contributedAssetsCount}`,
                },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  `*⚠️ Critical Data Integrity Issue:*\n` +
                  `Expansion closing failed due to invalid VT price. Cannot calculate multipliers with price Infinity.\n\n` +
                  `*Automatic Actions Taken:*\n` +
                  `• Vault set to manual distribution mode\n` +
                  `• Expansion closed without multipliers\n` +
                  `• Claims saved but amounts may need recalculation\n\n` +
                  `*Required Manual Actions:*\n` +
                  `1. Investigate why VT price is invalid (${data.priceType === 'limit' ? 'limit price' : 'vault VT price'})\n` +
                  `2. Review expansion claims for vault ${data.vaultId}\n` +
                  `3. Manually calculate and update vault multipliers\n` +
                  `4. Update claim amounts if necessary\n` +
                  `5. Disable manual distribution mode when resolved`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*Close Reason:* ${data.closeReason} | *Timestamp:* ${timestamp}`,
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
}
