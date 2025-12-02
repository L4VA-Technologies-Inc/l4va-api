import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleSecretService {
  private secretClient: SecretManagerServiceClient;
  private projectId: string;

  constructor(private readonly configService: ConfigService) {
    this.secretClient = new SecretManagerServiceClient();
    this.projectId = this.configService.get('GCP_PROJECT_ID');
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
