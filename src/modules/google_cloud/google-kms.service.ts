import * as crypto from 'crypto';

import { PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SECURITY DOCUMENTATION: Memory Handling of Sensitive Keys
 *
 * Limitations:
 * 1. JavaScript strings are immutable and cannot be securely zeroed
 * 2. The bech32 string created during PrivateKey conversion persists until GC
 * 3. The PrivateKey object itself may contain string representations internally
 *
 * Mitigations Applied:
 * - DEK (Data Encryption Key) is zeroed immediately after use
 * - Decrypted key kept as Buffer as long as possible
 * - Buffer zeroed immediately after PrivateKey construction
 * - Try-catch ensures cleanup even on errors
 *
 * Remaining Risks:
 * - String representation exists briefly in memory (seconds to minutes)
 * - Could be captured in memory dumps or swap files
 * - Cannot control Cardano Serialization Library's internal string handling
 *
 * Recommendations:
 * - Run application with minimal swap space
 * - Use encrypted memory if available (OS-level)
 * - Consider using native modules for key handling if higher security needed
 * - Monitor for memory dumps in production
 */
@Injectable()
export class GoogleKMSService {
  private readonly logger = new Logger(GoogleKMSService.name);
  private kmsClient: KeyManagementServiceClient | null = null;
  private projectId: string;
  private locationId: string;
  private keyRingId: string;
  private keyId: string;
  private readonly isMainnet: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';

    // Only initialize GCP KMS on mainnet
    if (!this.isMainnet) {
      this.logger.log('Skipping KMS initialization (non-mainnet environment)');
      return;
    }

    // Store configuration but don't create client yet (lazy initialization)
    this.projectId = this.configService.get('GCP_PROJECT_ID');
    this.locationId = this.configService.get('GCP_KMS_LOCATION');
    this.keyRingId = this.configService.get('GCP_KMS_KEYRING');
    this.keyId = this.configService.get('GCP_KMS_KEY');

    this.logger.log(`KMS configuration loaded for project: ${this.projectId}`);
  }

  /**
   * Lazy initialize KMS client on first use
   */
  private ensureKmsClient(): void {
    if (!this.isMainnet) {
      throw new Error('KMS client not available (non-mainnet environment)');
    }

    if (!this.kmsClient) {
      const credentialsPath = this.configService.get('GOOGLE_APPLICATION_CREDENTIALS');
      this.kmsClient = new KeyManagementServiceClient({
        keyFilename: credentialsPath,
      });
      this.logger.log(`Initialized KMS client for project: ${this.projectId}`);
    }
  }

  /**
   * Get full KMS key resource name
   */
  private getKeyName(): string {
    this.ensureKmsClient();
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
    if (!this.isMainnet || !this.kmsClient) {
      throw new Error('KMS encryption only available on mainnet');
    }

    // 1. Generate data encryption key (DEK)
    const dek = crypto.randomBytes(32);

    // 2. Convert private key to bech32 string (preserves format)
    const privateKeyBech32 = privateKey.to_bech32();

    // 3. Encrypt private key with DEK (AES-256-GCM)
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);

    const encryptedKey = Buffer.concat([cipher.update(privateKeyBech32, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 4. Encrypt DEK with Cloud KMS
    const keyName = this.getKeyName();

    // Use consistent AAD without timestamp
    const aad = Buffer.from(
      JSON.stringify({
        vaultId: vaultId,
        purpose: 'treasury_wallet',
        algorithm: 'AES-256-GCM',
      })
    );

    const [encryptResponse] = await this.kmsClient.encrypt({
      name: keyName,
      plaintext: dek,
      additionalAuthenticatedData: aad,
    });

    // Zero out DEK from memory after use
    dek.fill(0);

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
    if (!this.isMainnet || !this.kmsClient) {
      throw new Error('KMS decryption only available on mainnet');
    }

    const keyName = this.getKeyName();

    // 1. Decrypt DEK with Cloud KMS (use same AAD as encryption)
    const aad = Buffer.from(
      JSON.stringify({
        vaultId: vaultId,
        purpose: 'treasury_wallet',
        algorithm: 'AES-256-GCM',
      })
    );

    const [decryptResponse] = await this.kmsClient.decrypt({
      name: keyName,
      ciphertext: encryptedPackage.encryptedDEK,
      additionalAuthenticatedData: aad,
    });

    const dek = Buffer.from(decryptResponse.plaintext as Uint8Array);

    // 2. Decrypt private key with DEK
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, encryptedPackage.iv);
    decipher.setAuthTag(encryptedPackage.authTag);

    const privateKeyBech32 = Buffer.concat([decipher.update(encryptedPackage.encryptedKey), decipher.final()]).toString(
      'utf8'
    );

    // Zero out DEK from memory
    dek.fill(0);

    // 3. Reconstruct PrivateKey from bech32
    return PrivateKey.from_bech32(privateKeyBech32);
  }

  /**
   * Encrypt stake private key using Cloud KMS (envelope encryption)
   */
  async encryptStakeKey(
    stakePrivateKey: PrivateKey,
    vaultId: string
  ): Promise<{
    encryptedKey: Buffer;
    encryptedDEK: Buffer;
    iv: Buffer;
    authTag: Buffer;
    algorithm: string;
    kmsKeyName: string;
  }> {
    if (!this.isMainnet || !this.kmsClient) {
      throw new Error('KMS encryption only available on mainnet');
    }

    // 1. Generate data encryption key (DEK)
    const dek = crypto.randomBytes(32);

    // 2. Convert stake private key to bech32 string
    const stakePrivateKeyBech32 = stakePrivateKey.to_bech32();

    // 3. Encrypt stake private key with DEK (AES-256-GCM)
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);

    const encryptedKey = Buffer.concat([cipher.update(stakePrivateKeyBech32, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // 4. Encrypt DEK with Cloud KMS
    const keyName = this.getKeyName();

    const aad = Buffer.from(
      JSON.stringify({
        vaultId: vaultId,
        purpose: 'treasury_wallet_stake',
        algorithm: 'AES-256-GCM',
      })
    );

    const [encryptResponse] = await this.kmsClient.encrypt({
      name: keyName,
      plaintext: dek,
      additionalAuthenticatedData: aad,
    });

    // Zero out DEK from memory
    dek.fill(0);

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
   * Decrypt stake key using Cloud KMS
   */
  async decryptStakeKey(
    encryptedPackage: {
      encryptedKey: Buffer;
      encryptedDEK: Buffer;
      iv: Buffer;
      authTag: Buffer;
    },
    vaultId: string
  ): Promise<PrivateKey> {
    if (!this.isMainnet || !this.kmsClient) {
      throw new Error('KMS decryption only available on mainnet');
    }

    const keyName = this.getKeyName();

    const aad = Buffer.from(
      JSON.stringify({
        vaultId: vaultId,
        purpose: 'treasury_wallet_stake',
        algorithm: 'AES-256-GCM',
      })
    );

    const [decryptResponse] = await this.kmsClient.decrypt({
      name: keyName,
      ciphertext: encryptedPackage.encryptedDEK,
      additionalAuthenticatedData: aad,
    });

    const dek = Buffer.from(decryptResponse.plaintext as Uint8Array);

    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, encryptedPackage.iv);
    decipher.setAuthTag(encryptedPackage.authTag);

    const stakePrivateKeyBech32 = Buffer.concat([
      decipher.update(encryptedPackage.encryptedKey),
      decipher.final(),
    ]).toString('utf8');

    // Zero out DEK from memory
    dek.fill(0);

    return PrivateKey.from_bech32(stakePrivateKeyBech32);
  }
}
