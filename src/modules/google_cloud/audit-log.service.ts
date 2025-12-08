import { Storage } from '@google-cloud/storage';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';

@Injectable()
export class AuditLogService {
  private storage: Storage;
  private bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.storage = new Storage({
      projectId: this.configService.get('GCP_PROJECT_ID'),
    });
    this.bucketName = this.configService.get('GCP_AUDIT_BUCKET'); // 'l4va-treasury-audit-logs'
  }

  /**
   * Log treasury wallet operation
   */
  async log(event: { action: string; vaultId: string; userId: string; details: any; timestamp?: Date }): Promise<void> {
    const timestamp = event.timestamp || new Date();
    const filename = `${timestamp.toISOString().split('T')[0]}/${event.vaultId}/${Date.now()}.json`;

    const file = this.storage.bucket(this.bucketName).file(filename);

    await file.save(
      JSON.stringify(
        {
          ...event,
          timestamp: timestamp.toISOString(),
          ip_address: this.getClientIp(),
          user_agent: this.getUserAgent(),
        },
        null,
        2
      ),
      {
        contentType: 'application/json',
        metadata: {
          vaultId: event.vaultId,
          action: event.action,
          userId: event.userId,
        },
      }
    );
  }

  private getClientIp(): string {
    // Implementation depends on your request context
    return 'unknown';
  }

  private getUserAgent(): string {
    return 'unknown';
  }
}
