import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleSecretService {
  private readonly logger = new Logger(GoogleSecretService.name);
  private secretClient: SecretManagerServiceClient;
  private projectId: string;

  constructor(private readonly configService: ConfigService) {
    // Initialize with service account credentials
    const credentialsPath = this.configService.get('GOOGLE_APPLICATION_CREDENTIALS');

    this.secretClient = new SecretManagerServiceClient({
      keyFilename: credentialsPath,
    });

    this.projectId = this.configService.get('GCP_PROJECT_ID');

    this.logger.log(`Initialized Secret Manager client for project: ${this.projectId}`);
  }

  /**
   * Store master HD wallet seed
   */
  async storeMasterSeed(mnemonic: string): Promise<string> {
    const secretId = 'l4va-treasury-master-seed';
    const parent = `projects/${this.projectId}`;

    // Create secret
    const [secret] = await this.secretClient.createSecret({
      parent: parent,
      secretId: secretId,
      secret: {
        replication: {
          automatic: {},
        },
        labels: {
          purpose: 'treasury',
          environment: process.env.NODE_ENV || 'development',
        },
      },
    });

    // Add secret version with the mnemonic
    const [version] = await this.secretClient.addSecretVersion({
      parent: secret.name,
      payload: {
        data: Buffer.from(
          JSON.stringify({
            mnemonic: mnemonic,
            derivation_standard: 'CIP-1852',
            network: 'mainnet',
            created_at: new Date().toISOString(),
          })
        ),
      },
    });

    return version.name!;
  }

  /**
   * Retrieve master seed
   */
  async getMasterSeed(): Promise<{
    mnemonic: string;
    derivation_standard: string;
    network: string;
  }> {
    const secretName = `projects/${this.projectId}/secrets/l4va-treasury-master-seed/versions/latest`;

    const [version] = await this.secretClient.accessSecretVersion({
      name: secretName,
    });

    const payload = version.payload?.data?.toString();
    return JSON.parse(payload!);
  }
}
