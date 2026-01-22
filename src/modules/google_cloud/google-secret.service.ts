import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleSecretService {
  private readonly logger = new Logger(GoogleSecretService.name);
  private secretClient: SecretManagerServiceClient | null = null;
  private projectId: string;
  private readonly isMainnet: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';

    // Store configuration but don't create client yet (lazy initialization)
    this.projectId = this.configService.get('GCP_PROJECT_ID');

    this.logger.log(
      `Secret Manager configuration loaded for ${this.isMainnet ? 'mainnet' : 'testnet'}, project: ${this.projectId}`
    );
  }

  /**
   * Lazy initialize Secret Manager client on first use
   */
  private ensureSecretClient(): void {
    if (!this.secretClient) {
      const credentialsPath = this.configService.get('GOOGLE_APPLICATION_CREDENTIALS');
      this.secretClient = new SecretManagerServiceClient({
        keyFilename: credentialsPath,
      });
      this.logger.log(
        `Initialized Secret Manager client for ${this.isMainnet ? 'mainnet' : 'testnet'}, project: ${this.projectId}`
      );
    }
  }

  /**
   * Create a new secret in Google Secret Manager
   */
  async createSecret(secretId: string, labels: Record<string, string>): Promise<string> {
    this.ensureSecretClient();

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
    this.ensureSecretClient();

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
    this.ensureSecretClient();

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
    this.ensureSecretClient();

    const name = `projects/${this.projectId}/secrets/${secretId}`;

    await this.secretClient.deleteSecret({ name });
    this.logger.log(`Deleted secret: ${secretId}`);
  }

  /**
   * Store master HD wallet seed
   */
  async storeMasterSeed(mnemonic: string): Promise<string> {
    // Keep original name for mainnet backward compatibility
    const secretId = this.isMainnet ? 'l4va-treasury-master-seed' : 'l4va-treasury-master-seed-testnet';

    const labels = {
      purpose: 'treasury',
      network: this.isMainnet ? 'mainnet' : 'testnet',
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
    // Keep original name for mainnet backward compatibility
    const secretId = this.isMainnet ? 'l4va-treasury-master-seed' : 'l4va-treasury-master-seed-testnet';
    return await this.getSecretValue(secretId);
  }
}
