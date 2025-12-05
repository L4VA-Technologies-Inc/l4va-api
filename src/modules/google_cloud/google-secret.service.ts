import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleSecretService {
  private readonly logger = new Logger(GoogleSecretService.name);
  private secretClient: SecretManagerServiceClient;
  private projectId: string;

  constructor(private readonly configService: ConfigService) {
    const credentialsPath = this.configService.get('GOOGLE_APPLICATION_CREDENTIALS');

    this.secretClient = new SecretManagerServiceClient({
      keyFilename: credentialsPath,
    });

    this.projectId = this.configService.get('GCP_PROJECT_ID');

    this.logger.log(`Initialized Secret Manager client for project: ${this.projectId}`);
  }

  /**
   * Create a new secret in Google Secret Manager
   */
  async createSecret(secretId: string, labels: Record<string, string>): Promise<string> {
    const parent = `projects/${this.projectId}`;

    const [secret] = await this.secretClient.createSecret({
      parent,
      secretId,
      secret: {
        replication: {
          automatic: {},
        },
        labels,
      },
    });

    this.logger.log(`Created secret: ${secretId}`);
    return secret.name!;
  }

  /**
   * Add a new version to an existing secret
   */
  async addSecretVersion(secretId: string, data: Record<string, any>): Promise<string> {
    const parent = `projects/${this.projectId}/secrets/${secretId}`;

    const [version] = await this.secretClient.addSecretVersion({
      parent,
      payload: {
        data: Buffer.from(JSON.stringify(data)),
      },
    });

    return version.name!;
  }

  /**
   * Get the latest version of a secret
   */
  async getSecretValue(secretId: string): Promise<any> {
    const name = `projects/${this.projectId}/secrets/${secretId}/versions/latest`;

    const [version] = await this.secretClient.accessSecretVersion({
      name,
    });

    const payload = version.payload?.data?.toString();
    return JSON.parse(payload!);
  }

  /**
   * Delete a secret from Secret Manager
   */
  async deleteSecret(secretId: string): Promise<void> {
    const name = `projects/${this.projectId}/secrets/${secretId}`;

    await this.secretClient.deleteSecret({ name });
    this.logger.log(`Deleted secret: ${secretId}`);
  }

  /**
   * Store master HD wallet seed
   */
  async storeMasterSeed(mnemonic: string): Promise<string> {
    const secretId = 'l4va-treasury-master-seed';

    const labels = {
      purpose: 'treasury',
      environment: process.env.NODE_ENV || 'development',
    };

    const data = {
      mnemonic,
      derivation_standard: 'CIP-1852',
      network: 'mainnet',
      created_at: new Date().toISOString(),
    };

    try {
      await this.createSecret(secretId, labels);
      return await this.addSecretVersion(secretId, data);
    } catch (error) {
      // If secret exists, just add new version
      return await this.addSecretVersion(secretId, data);
    }
  }

  /**
   * Retrieve master seed
   */
  async getMasterSeed(): Promise<{
    mnemonic: string;
    derivation_standard: string;
    network: string;
  }> {
    return await this.getSecretValue('l4va-treasury-master-seed');
  }
}
