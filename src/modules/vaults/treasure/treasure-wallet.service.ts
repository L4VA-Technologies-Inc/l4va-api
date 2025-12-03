import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { GoogleKMSService } from '@/modules/google_cloud/google-kms.service';
import { GoogleSecretService } from '@/modules/google_cloud/google-secret.service';
import { generateCardanoWallet } from '@/modules/vaults/processing-tx/onchain/utils/lib';

export interface CreateTreasuryWalletDto {
  vaultId: string;
}

export interface TreasuryWalletInfo {
  id: string;
  vaultId: string;
  address: string;
  publicKeyHash: string;
  createdAt: Date;
}

@Injectable()
export class TreasuryWalletService {
  private readonly logger = new Logger(TreasuryWalletService.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(VaultTreasuryWallet)
    private readonly treasuryWalletRepository: Repository<VaultTreasuryWallet>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly googleKMSService: GoogleKMSService,
    private readonly googleSecretService: GoogleSecretService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Creates a new treasury wallet for a vault
   * Called automatically when vault transitions to 'locked' status
   */
  async createTreasuryWallet(dto: CreateTreasuryWalletDto): Promise<TreasuryWalletInfo> {
    const { vaultId } = dto;

    this.logger.log(`Creating treasury wallet for vault ${vaultId}`);

    // Check if vault exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Check if treasury wallet already exists for this vault
    const existingWallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (existingWallet) {
      this.logger.warn(`Treasury wallet already exists for vault ${vaultId}`);
      return {
        id: existingWallet.id,
        vaultId: existingWallet.vault_id,
        address: existingWallet.treasury_address,
        publicKeyHash: existingWallet.public_key_hash,
        createdAt: existingWallet.created_at,
      };
    }

    // Generate new Cardano wallet
    const walletData = await generateCardanoWallet(this.isMainnet);

    // Extract public key hash from the private key
    const privateKey = PrivateKey.from_bech32(walletData.privateKey);
    const publicKey = privateKey.to_public();
    const publicKeyHash = publicKey.hash().to_hex();

    // Encrypt private key using Google Cloud KMS (envelope encryption)
    this.logger.log(`Encrypting private key for vault ${vaultId} using Google Cloud KMS`);
    const encryptedPackage = await this.googleKMSService.encryptTreasuryKey(privateKey, vaultId);

    // Store the encrypted package in database
    const encryptedData = {
      encryptedKey: encryptedPackage.encryptedKey.toString('base64'),
      encryptedDEK: encryptedPackage.encryptedDEK.toString('base64'),
      iv: encryptedPackage.iv.toString('base64'),
      authTag: encryptedPackage.authTag.toString('base64'),
      algorithm: encryptedPackage.algorithm,
      kmsKeyName: encryptedPackage.kmsKeyName,
    };

    const encryptedBuffer = Buffer.from(JSON.stringify(encryptedData));

    // Optionally store mnemonic in Google Secret Manager (for recovery)
    let secretVersionName: string | undefined;
    try {
      this.logger.log(`Storing mnemonic in Google Secret Manager for vault ${vaultId}`);
      secretVersionName = await this.storeWalletMnemonic(vaultId, walletData.mnemonic, vault.name);
      this.logger.log(`Mnemonic stored: ${secretVersionName}`);
    } catch (error) {
      this.logger.error(`Failed to store mnemonic in Secret Manager: ${error.message}`);
      // Continue without failing - the encrypted private key is still available
    }

    // Create treasury wallet record
    const treasuryWallet = this.treasuryWalletRepository.create({
      vault_id: vaultId,
      treasury_address: walletData.address,
      public_key_hash: publicKeyHash,
      encrypted_private_key: encryptedBuffer,
      encryption_key_id: encryptedPackage.kmsKeyName,
      metadata: {
        createdBy: 'system',
        vaultName: vault.name,
        network: this.isMainnet ? 'mainnet' : 'preprod',
        encryptionMethod: 'google-kms-envelope',
        secretManagerVersion: secretVersionName,
        createdAt: new Date().toISOString(),
      },
      is_active: true,
    });

    await this.treasuryWalletRepository.save(treasuryWallet);

    this.logger.log(`✅ Treasury wallet created for vault ${vaultId}: ${walletData.address}`);

    return {
      id: treasuryWallet.id,
      vaultId: treasuryWallet.vault_id,
      address: treasuryWallet.treasury_address,
      publicKeyHash: treasuryWallet.public_key_hash,
      createdAt: treasuryWallet.created_at,
    };
  }

  /**
   * Store wallet mnemonic in Google Secret Manager
   */
  private async storeWalletMnemonic(vaultId: string, mnemonic: string, vaultName: string): Promise<string> {
    const secretId = `treasury-wallet-${vaultId}`;
    const projectId = this.configService.get('GCP_PROJECT_ID');

    const secretClient = this.googleSecretService['secretClient'];
    const parent = `projects/${projectId}`;

    try {
      // Create secret
      const [secret] = await secretClient.createSecret({
        parent: parent,
        secretId: secretId,
        secret: {
          replication: {
            automatic: {},
          },
          labels: {
            purpose: 'treasury_wallet',
            vault_id: vaultId.replace(/-/g, '_'), // GCP labels don't allow hyphens
            vault_name: vaultName.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            environment: process.env.NODE_ENV || 'development',
          },
        },
      });

      // Add secret version with the mnemonic
      const [version] = await secretClient.addSecretVersion({
        parent: secret.name,
        payload: {
          data: Buffer.from(
            JSON.stringify({
              mnemonic: mnemonic,
              vaultId: vaultId,
              vaultName: vaultName,
              derivation_standard: 'CIP-1852',
              network: this.isMainnet ? 'mainnet' : 'preprod',
              created_at: new Date().toISOString(),
            })
          ),
        },
      });

      return version.name!;
    } catch (error) {
      if (error.code === 6) {
        // Secret already exists, add a new version
        this.logger.warn(`Secret ${secretId} already exists, adding new version`);
        const secretName = `${parent}/secrets/${secretId}`;
        const [version] = await secretClient.addSecretVersion({
          parent: secretName,
          payload: {
            data: Buffer.from(
              JSON.stringify({
                mnemonic: mnemonic,
                vaultId: vaultId,
                vaultName: vaultName,
                derivation_standard: 'CIP-1852',
                network: this.isMainnet ? 'mainnet' : 'preprod',
                created_at: new Date().toISOString(),
              })
            ),
          },
        });
        return version.name!;
      }
      throw error;
    }
  }

  /**
   * Gets treasury wallet for a vault
   */
  async getTreasuryWallet(vaultId: string): Promise<TreasuryWalletInfo | null> {
    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      return null;
    }

    return {
      id: wallet.id,
      vaultId: wallet.vault_id,
      address: wallet.treasury_address,
      publicKeyHash: wallet.public_key_hash,
      createdAt: wallet.created_at,
    };
  }

  /**
   * Gets decrypted private key for treasury wallet (USE WITH CAUTION)
   * Decrypts using Google Cloud KMS
   */
  async getTreasuryWalletPrivateKey(vaultId: string): Promise<PrivateKey> {
    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    if (!wallet.encrypted_private_key) {
      throw new Error(`Treasury wallet ${wallet.id} has no encrypted private key`);
    }

    try {
      // Parse the encrypted package from database
      const encryptedData = JSON.parse(wallet.encrypted_private_key.toString());

      const encryptedPackage = {
        encryptedKey: Buffer.from(encryptedData.encryptedKey, 'base64'),
        encryptedDEK: Buffer.from(encryptedData.encryptedDEK, 'base64'),
        iv: Buffer.from(encryptedData.iv, 'base64'),
        authTag: Buffer.from(encryptedData.authTag, 'base64'),
      };

      this.logger.log(`Decrypting private key for vault ${vaultId} using Google Cloud KMS`);

      // Decrypt using Google Cloud KMS
      const privateKey = await this.googleKMSService.decryptTreasuryKey(encryptedPackage, vaultId);

      return privateKey;
    } catch (error) {
      this.logger.error(`Failed to decrypt treasury wallet ${wallet.id}:`, error);
      throw new Error(`Failed to decrypt treasury wallet credentials: ${error.message}`);
    }
  }

  /**
   * Gets mnemonic from Google Secret Manager (for recovery purposes)
   */
  async getTreasuryWalletMnemonic(vaultId: string): Promise<string> {
    const projectId = this.configService.get('GCP_PROJECT_ID');
    const secretName = `projects/${projectId}/secrets/treasury-wallet-${vaultId}/versions/latest`;

    const secretClient = this.googleSecretService['secretClient'];

    try {
      const [version] = await secretClient.accessSecretVersion({
        name: secretName,
      });

      const payload = version.payload?.data?.toString();
      const data = JSON.parse(payload!);

      return data.mnemonic;
    } catch (error) {
      this.logger.error(`Failed to retrieve mnemonic for vault ${vaultId}:`, error);
      throw new Error(`Failed to retrieve wallet mnemonic: ${error.message}`);
    }
  }

  /**
   * Gets treasury wallet balance
   */
  async getTreasuryWalletBalance(vaultId: string): Promise<{
    lovelace: number;
    assets: Array<{ unit: string; quantity: string; policyId: string; assetName: string }>;
  }> {
    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    try {
      const utxos = await this.blockfrost.addressesUtxosAll(wallet.treasury_address);

      let totalLovelace = 0;
      const assetsMap = new Map<string, bigint>();

      for (const utxo of utxos) {
        for (const amount of utxo.amount) {
          if (amount.unit === 'lovelace') {
            totalLovelace += Number(amount.quantity);
          } else {
            const current = assetsMap.get(amount.unit) || BigInt(0);
            assetsMap.set(amount.unit, current + BigInt(amount.quantity));
          }
        }
      }

      const assets = Array.from(assetsMap.entries()).map(([unit, quantity]) => ({
        unit,
        quantity: quantity.toString(),
        policyId: unit.slice(0, 56),
        assetName: unit.slice(56),
      }));

      return {
        lovelace: totalLovelace,
        assets,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch balance for treasury wallet ${wallet.treasury_address}:`, error);
      throw new Error(`Failed to fetch treasury wallet balance: ${error.message}`);
    }
  }

  /**
   * Lists all treasury wallets
   */
  async listTreasuryWallets(filters?: {
    vaultIds?: string[];
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<TreasuryWalletInfo[]> {
    const queryBuilder = this.treasuryWalletRepository.createQueryBuilder('wallet');

    if (filters?.vaultIds && filters.vaultIds.length > 0) {
      queryBuilder.andWhere('wallet.vault_id IN (:...vaultIds)', { vaultIds: filters.vaultIds });
    }

    if (filters?.isActive !== undefined) {
      queryBuilder.andWhere('wallet.is_active = :isActive', { isActive: filters.isActive });
    }

    if (filters?.limit) {
      queryBuilder.take(filters.limit);
    }

    if (filters?.offset) {
      queryBuilder.skip(filters.offset);
    }

    const wallets = await queryBuilder.orderBy('wallet.created_at', 'DESC').getMany();

    return wallets.map(wallet => ({
      id: wallet.id,
      vaultId: wallet.vault_id,
      address: wallet.treasury_address,
      publicKeyHash: wallet.public_key_hash,
      createdAt: wallet.created_at,
    }));
  }

  /**
   * Deactivates a treasury wallet (doesn't delete, just marks inactive)
   */
  async deactivateTreasuryWallet(vaultId: string): Promise<void> {
    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    wallet.is_active = false;
    wallet.metadata = {
      ...wallet.metadata,
      deactivatedAt: new Date().toISOString(),
    };
    await this.treasuryWalletRepository.save(wallet);

    this.logger.log(`Deactivated treasury wallet for vault ${vaultId}`);
  }
}
