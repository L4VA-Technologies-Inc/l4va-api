import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateTreasuryWalletDto } from './dto/create-treasury-wallet.dto';
import { TreasuryWalletInfoDto } from './dto/treasury-wallet-info.dto';

import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { GoogleKMSService } from '@/modules/google_cloud/google-kms.service';
import { GoogleSecretService } from '@/modules/google_cloud/google-secret.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { generateCardanoWallet, getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { VaultStatus } from '@/types/vault.types';
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
    private readonly googleSecretService: GoogleSecretService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly blockchainService: BlockchainService
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
  async createTreasuryWallet(dto: CreateTreasuryWalletDto): Promise<TreasuryWalletInfoDto> {
    const { vaultId } = dto;

    // Check if treasury wallets are enabled for current network
    // On testnet, check if feature is enabled. On mainnet, always allow sweep.
    if (!this.isMainnet && !this.systemSettingsService.autoCreateTreasuryWalletsTestnet) {
      this.logger.log(`Treasury wallets are disabled for ${this.isMainnet ? 'mainnet' : 'testnet'} `);
      return null;
    }

    this.logger.log(`Creating treasury wallet for vault ${vaultId} on ${this.isMainnet ? 'mainnet' : 'testnet'}`);

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

    // Extract public key hash from the payment private key
    const privateKey = PrivateKey.from_bech32(walletData.privateKey);
    const stakePrivateKey = PrivateKey.from_bech32(walletData.stakePrivateKey);
    const publicKey = privateKey.to_public();
    const publicKeyHash = publicKey.hash().to_hex();

    // Encrypt BOTH keys using Google Cloud KMS
    const encryptedPackage = await this.googleKMSService.encryptTreasuryKey(privateKey, vaultId);
    const encryptedStakePackage = await this.googleKMSService.encryptStakeKey(stakePrivateKey, vaultId);

    // Store both encrypted packages
    const encryptedData = {
      encryptedKey: encryptedPackage.encryptedKey.toString('base64'),
      encryptedDEK: encryptedPackage.encryptedDEK.toString('base64'),
      iv: encryptedPackage.iv.toString('base64'),
      authTag: encryptedPackage.authTag.toString('base64'),
      algorithm: encryptedPackage.algorithm,
      kmsKeyName: encryptedPackage.kmsKeyName,
    };

    const encryptedStakeData = {
      encryptedKey: encryptedStakePackage.encryptedKey.toString('base64'),
      encryptedDEK: encryptedStakePackage.encryptedDEK.toString('base64'),
      iv: encryptedStakePackage.iv.toString('base64'),
      authTag: encryptedStakePackage.authTag.toString('base64'),
      algorithm: encryptedStakePackage.algorithm,
      kmsKeyName: encryptedStakePackage.kmsKeyName,
    };

    const encryptedBuffer = Buffer.from(JSON.stringify(encryptedData));
    const encryptedStakeBuffer = Buffer.from(JSON.stringify(encryptedStakeData));

    // Optionally store mnemonic in Google Secret Manager (for recovery)
    let secretVersionName: string | undefined;
    try {
      secretVersionName = await this.storeWalletMnemonic(vaultId, walletData.mnemonic, vault.name);
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
      encrypted_stake_private_key: encryptedStakeBuffer,
      encryption_key_id: encryptedPackage.kmsKeyName,
      metadata: {
        createdBy: 'system',
        vaultName: vault.name,
        network: this.isMainnet ? 'mainnet' : 'preprod',
        encryptionMethod: 'google-kms-envelope',
        secretManagerVersion: secretVersionName,
      },
      is_active: true,
    });

    await this.treasuryWalletRepository.save(treasuryWallet);

    this.eventEmitter.emit('treasury.wallet.created', {
      vaultId: vault.id,
      vaultName: vault.name,
      treasuryAddress: treasuryWallet.treasury_address,
      publicKeyHash: publicKeyHash,
    });

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

    const labels = {
      purpose: 'treasury_wallet',
      vault_id: vaultId.replace(/-/g, '_'),
      vault_name: vaultName.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      environment: process.env.NODE_ENV || 'development',
    };

    const data = {
      mnemonic,
      vaultId,
      vaultName,
      derivation_standard: 'CIP-1852',
      network: this.isMainnet ? 'mainnet' : 'preprod',
      created_at: new Date().toISOString(),
    };

    try {
      await this.googleSecretService.createSecret(secretId, labels);
      return await this.googleSecretService.addSecretVersion(secretId, data);
    } catch (error: any) {
      if (error.code === GrpcStatus.ALREADY_EXISTS) {
        this.logger.warn(`Secret ${secretId} already exists, adding new version`);
        return await this.googleSecretService.addSecretVersion(secretId, data);
      }

      this.logger.error(
        `Failed to store mnemonic for vault ${vaultId}. ` + `Error code: ${error.code}, Message: ${error.message}`
      );

      throw error;
    }
  }

  /**
   * Gets treasury wallet for a vault
   */
  async getTreasuryWallet(vaultId: string): Promise<TreasuryWalletInfoDto | null> {
    if (!this.isMainnet && !this.systemSettingsService.autoCreateTreasuryWalletsTestnet) {
      return null;
    }

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
  async getTreasuryWalletPrivateKey(vaultId: string): Promise<{
    privateKey: PrivateKey;
    stakePrivateKey: PrivateKey;
  }> {
    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    if (!wallet.encrypted_private_key || !wallet.encrypted_stake_private_key) {
      throw new Error(`Treasury wallet ${wallet.id} has no encrypted keys`);
    }

    try {
      // Decrypt payment key
      const encryptedData = JSON.parse(wallet.encrypted_private_key.toString());
      const encryptedPackage = {
        encryptedKey: Buffer.from(encryptedData.encryptedKey, 'base64'),
        encryptedDEK: Buffer.from(encryptedData.encryptedDEK, 'base64'),
        iv: Buffer.from(encryptedData.iv, 'base64'),
        authTag: Buffer.from(encryptedData.authTag, 'base64'),
      };

      // Decrypt stake key
      const encryptedStakeData = JSON.parse(wallet.encrypted_stake_private_key.toString());
      const encryptedStakePackage = {
        encryptedKey: Buffer.from(encryptedStakeData.encryptedKey, 'base64'),
        encryptedDEK: Buffer.from(encryptedStakeData.encryptedDEK, 'base64'),
        iv: Buffer.from(encryptedStakeData.iv, 'base64'),
        authTag: Buffer.from(encryptedStakeData.authTag, 'base64'),
      };

      this.logger.log(`Decrypting keys for vault ${vaultId}`);

      const privateKey = await this.googleKMSService.decryptTreasuryKey(encryptedPackage, vaultId);
      const stakePrivateKey = await this.googleKMSService.decryptStakeKey(encryptedStakePackage, vaultId);

      return { privateKey, stakePrivateKey };
    } catch (error) {
      this.logger.error(`Failed to decrypt treasury wallet ${wallet.id}:`, error);
      throw new Error(`Failed to decrypt treasury wallet credentials: ${error.message}`);
    }
  }

  /**
   * Gets mnemonic from Google Secret Manager (for recovery purposes)
   */
  async getTreasuryWalletMnemonic(vaultId: string): Promise<string> {
    const secretId = `treasury-wallet-${vaultId}`;

    try {
      const data = await this.googleSecretService.getSecretValue(secretId);
      return data.mnemonic;
    } catch (error: any) {
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

  /**
   * Delete secret when vault is burned/closed
   */
  async deleteVaultSecret(vaultId: string): Promise<void> {
    const secretId = `treasury-wallet-${vaultId}`;

    try {
      await this.googleSecretService.deleteSecret(secretId);
      this.logger.log(`Deleted secret for vault ${vaultId}`);
    } catch (error: any) {
      this.logger.error(`Failed to delete secret for vault ${vaultId}:`, error);
      throw error;
    }
  }

  /**
   * Check if vault has a treasury wallet
   * Returns false if no wallet exists or if treasury wallets are disabled for the current network
   */
  async hasTreasuryWallet(vaultId: string): Promise<boolean> {
    if (!this.isMainnet) {
      return false;
    }

    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId, is_active: true },
      select: ['id'],
    });

    return !!wallet;
  }

  /**
   * Sweep all remaining ADA from treasury wallet to destination address
   * Used during vault termination cleanup to recover any leftover funds
   */
  async sweepTreasuryWallet(vaultId: string, destinationAddress: string): Promise<string> {
    // On testnet, check if feature is enabled. On mainnet, always allow sweep.
    if (!this.isMainnet && !this.systemSettingsService.autoCreateTreasuryWalletsTestnet) {
      throw new Error(`Treasury wallet sweep disabled for testnet`);
    }

    this.logger.log(`Sweeping treasury wallet for vault ${vaultId} to ${destinationAddress}`);

    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    // Get wallet balance to check if sweep is worthwhile
    const balance = await this.getTreasuryWalletBalance(vaultId);

    if (balance.lovelace <= 1_000_000) {
      // Less than 1 ADA, not worth sweeping
      this.logger.warn(`Treasury wallet has only ${balance.lovelace} lovelace - too small to sweep`);
      return null;
    }

    // Get wallet UTXOs using the standard utility
    const { utxos: walletUtxos } = await getUtxosExtract(
      Address.from_bech32(wallet.treasury_address),
      this.blockfrost,
      {
        validateUtxos: true,
      }
    );

    if (walletUtxos.length === 0) {
      throw new Error(`Treasury wallet has no UTXOs to sweep`);
    }

    // Get decrypted keys for signing
    const { privateKey, stakePrivateKey } = await this.getTreasuryWalletPrivateKey(vaultId);
    const publicKey = privateKey.to_public();
    const publicKeyHash = publicKey.hash().to_hex();

    // Build outputs - include any native assets if present
    const outputs: any[] = [];

    if (balance.assets.length > 0) {
      // If there are native assets, we need to send them along with ADA
      const assets = balance.assets.map(asset => ({
        policyId: asset.policyId,
        assetName: { name: asset.assetName, format: 'hex' as const },
        quantity: parseInt(asset.quantity),
      }));

      outputs.push({
        address: destinationAddress,
        lovelace: balance.lovelace.toString(),
        assets,
      });
    } else {
      // Pure ADA sweep - let the builder calculate fee
      outputs.push({
        address: destinationAddress,
        lovelace: balance.lovelace.toString(),
      });
    }

    // Build transaction using blockchainService
    const input = {
      changeAddress: destinationAddress,
      utxos: walletUtxos,
      message: `Sweep treasury wallet for vault ${vaultId}`,
      outputs,
      requiredSigners: [publicKeyHash],
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.configService.get<string>('CARDANO_NETWORK'),
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);

    // Sign with treasury wallet keys
    const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmit.sign_and_add_vkey_signature(privateKey);
    txToSubmit.sign_and_add_vkey_signature(stakePrivateKey);

    // Submit transaction
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmit.to_hex(),
    });

    this.logger.log(`Treasury wallet swept successfully: ${submitResponse.txHash}`);
    return submitResponse.txHash;
  }

  /**
   * Delete KMS encryption keys for treasury wallet
   * Called during vault termination cleanup
   */
  async deleteTreasuryWalletKeys(vaultId: string): Promise<void> {
    // Check if treasury wallets are enabled for current network
    if (!this.isMainnet && !this.systemSettingsService.autoCreateTreasuryWalletsTestnet) {
      this.logger.log(
        `Skipping KMS key deletion - treasury wallets disabled for ${this.isMainnet ? 'mainnet' : 'testnet'}`
      );
      return;
    }

    this.logger.log(
      `Deleting KMS keys for vault ${vaultId} treasury wallet on ${this.isMainnet ? 'mainnet' : 'testnet'}`
    );

    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    try {
      // Delete secret from Secret Manager (contains mnemonic)
      await this.deleteVaultSecret(vaultId);
      this.logger.log(`Deleted secret for vault ${vaultId}`);
    } catch (error: any) {
      // If secret doesn't exist, that's fine
      if (error.code !== 5 && !error.message?.includes('not found')) {
        this.logger.error(`Failed to delete secret for vault ${vaultId}:`, error);
        throw error;
      }
    }

    this.logger.log(`KMS keys deleted for vault ${vaultId}`);
  }

  /**
   * Mark treasury wallet as deleted in database
   * Does not actually delete the record, just marks it as inactive
   */
  async markTreasuryWalletAsDeleted(vaultId: string): Promise<void> {
    const wallet = await this.treasuryWalletRepository.findOne({
      where: { vault_id: vaultId },
    });

    if (!wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    wallet.is_active = false;
    wallet.metadata = {
      ...wallet.metadata,
      deletedAt: new Date().toISOString(),
      deletionReason: 'vault_terminated',
    };

    // Clear encrypted keys from database for security
    wallet.encrypted_private_key = null;
    wallet.encrypted_stake_private_key = null;

    await this.treasuryWalletRepository.save(wallet);

    this.logger.log(`Marked treasury wallet as deleted for vault ${vaultId}`);
  }

  /**
   * Cron job to auto-create treasury wallets for locked vaults
   * Schedule controlled by TREASURY_WALLET_CRON env variable (defaults to every 6 hours)
   * Controlled by auto_create_treasury_wallets feature flag in system settings
   */
  @Cron(process.env.TREASURY_WALLET_CRON || CronExpression.EVERY_6_HOURS)
  async autoCreateMissingTreasuryWallets(): Promise<void> {
    const isEnabled = this.systemSettingsService.autoCreateTreasuryWallets;

    if (!isEnabled) {
      this.logger.debug(`Auto-create treasury wallets is disabled for ${this.isMainnet ? 'mainnet' : 'testnet'}`);
      return;
    }

    this.logger.log('Starting auto-create treasury wallets cron job');

    try {
      // Find locked/governance vaults without treasury wallets
      const vaultsNeedingWallets: Pick<Vault, 'id' | 'name' | 'vault_status'>[] = await this.vaultRepository
        .createQueryBuilder('vault')
        .leftJoin(VaultTreasuryWallet, 'wallet', 'wallet.vault_id = vault.id')
        .where('vault.vault_status IN (:...statuses)', {
          statuses: [VaultStatus.locked],
        })
        .andWhere('vault.deleted = :deleted', { deleted: false })
        .andWhere('wallet.id IS NULL') // No treasury wallet exists
        .select(['vault.id', 'vault.name', 'vault.vault_status'])
        .getMany();

      if (vaultsNeedingWallets.length === 0) {
        this.logger.log('No vaults need treasury wallets');
        return;
      }

      this.logger.log(`Found ${vaultsNeedingWallets.length} vault(s) without treasury wallets`);

      let successCount = 0;
      let failureCount = 0;

      for (const vault of vaultsNeedingWallets) {
        try {
          const wallet = await this.createTreasuryWallet({ vaultId: vault.id });
          if (wallet) {
            this.logger.log(`✅ Created treasury wallet for vault ${vault.name} (${vault.id})`);
            successCount++;
          }
        } catch (error) {
          this.logger.error(
            `❌ Failed to create treasury wallet for vault ${vault.name} (${vault.id}): ${error.message}`
          );
          failureCount++;
        }
      }

      this.logger.log(`Auto-create treasury wallets completed: ${successCount} succeeded, ${failureCount} failed`);
    } catch (error) {
      this.logger.error('Auto-create treasury wallets cron job failed:', error);
    }
  }
}
