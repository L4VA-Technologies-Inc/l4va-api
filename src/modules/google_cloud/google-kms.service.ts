import * as crypto from 'crypto';

import { PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleKMSService {
  private kmsClient: KeyManagementServiceClient;
  private projectId: string;
  private locationId: string;
  private keyRingId: string;
  private keyId: string;

  constructor(private readonly configService: ConfigService) {
    this.kmsClient = new KeyManagementServiceClient();
    this.projectId = this.configService.get('GCP_PROJECT_ID');
    this.locationId = this.configService.get('GCP_KMS_LOCATION'); // e.g., 'global' or 'us-east1'
    this.keyRingId = this.configService.get('GCP_KMS_KEYRING'); // e.g., 'l4va-treasury'
    this.keyId = this.configService.get('GCP_KMS_KEY'); // e.g., 'treasury-encryption-key'
  }

  /**
   * Get full KMS key resource name
   */
  private getKeyName(): string {
    return this.kmsClient.cryptoKeyPath(this.projectId, this.locationId, this.keyRingId, this.keyId);
  }

  /**
   * Encrypt data using Cloud KMS (envelope encryption)
   */
  async encryptTreasuryKey(
    privateKey: PrivateKey,
    vaultId: string
  ): Promise<{
    encryptedKey: Buffer;
    encryptedDEK: Buffer;
    iv: Buffer;
    authTag: Buffer;
    algorithm: string;
    kmsKeyName: string;
  }> {
    // 1. Generate data encryption key (DEK)
    const dek = crypto.randomBytes(32);

    // 2. Encrypt private key with DEK (AES-256-GCM)
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);

    const encryptedKey = Buffer.concat([cipher.update(privateKey.as_bytes()), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 3. Encrypt DEK with Cloud KMS
    const keyName = this.getKeyName();

    const [encryptResponse] = await this.kmsClient.encrypt({
      name: keyName,
      plaintext: dek,
      additionalAuthenticatedData: Buffer.from(
        JSON.stringify({
          vaultId: vaultId,
          purpose: 'treasury_wallet',
          timestamp: Date.now(),
        })
      ),
    });

    return {
      encryptedKey,
      encryptedDEK: Buffer.from(encryptResponse.ciphertext as Uint8Array),
      iv,
      authTag,
      algorithm: 'AES-256-GCM',
      kmsKeyName: keyName,
    };
  }

  /**
   * Decrypt treasury key using Cloud KMS
   */
  async decryptTreasuryKey(
    encryptedPackage: {
      encryptedKey: Buffer;
      encryptedDEK: Buffer;
      iv: Buffer;
      authTag: Buffer;
    },
    vaultId: string
  ): Promise<PrivateKey> {
    const keyName = this.getKeyName();

    // 1. Decrypt DEK with Cloud KMS
    const [decryptResponse] = await this.kmsClient.decrypt({
      name: keyName,
      ciphertext: encryptedPackage.encryptedDEK,
      additionalAuthenticatedData: Buffer.from(
        JSON.stringify({
          vaultId: vaultId,
          purpose: 'treasury_wallet',
          // Note: timestamp not needed for decryption, KMS validates AAD
        })
      ),
    });

    const dek = Buffer.from(decryptResponse.plaintext as Uint8Array);

    // 2. Decrypt private key with DEK
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, encryptedPackage.iv);
    decipher.setAuthTag(encryptedPackage.authTag);

    const privateKeyBytes = Buffer.concat([decipher.update(encryptedPackage.encryptedKey), decipher.final()]);

    // Zero out DEK from memory
    dek.fill(0);

    return PrivateKey.from_normal_bytes(privateKeyBytes);
  }
}
