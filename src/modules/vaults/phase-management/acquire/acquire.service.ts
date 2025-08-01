import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';

import { AcquireReq } from './dto/acquire.req';

import { Asset } from '@/database/asset.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetType, AssetStatus, AssetOriginType } from '@/types/asset.types';
import { TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AcquireService {
  private readonly logger = new Logger(AcquireService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly transactionsService: TransactionsService
  ) {}

  async acquire(vaultId: string, acquireReq: AcquireReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['acquirer_whitelist', 'owner'],
    });

    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.acquire) {
      throw new BadRequestException('Vault is not in acquire phase');
    }

    // Validate assets
    if (!acquireReq.assets || !Array.isArray(acquireReq.assets) || acquireReq.assets.length === 0) {
      throw new BadRequestException('At least one asset is required');
    }

    // Allow vault owner to bypass whitelist check
    if (vault.owner.id !== userId) {
      // Check whitelist only for non-owners
      if (vault.acquirer_whitelist?.length > 0) {
        const isWhitelisted = vault.acquirer_whitelist.some(entry => entry.wallet_address === user.address);
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in investor whitelist');
        }
      }
    }

    // Validate assets against vault settings if needed
    if (vault.value_method === 'fixed') {
      // Add any specific validation for fixed valuation type here
    }

    // Create a transaction record for the acquire
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.acquire,
      assets: [],
      userId,
    });

    // Create assets for the transaction
    if (acquireReq.assets.length > 0) {
      try {
        // Ensure the transaction exists and is loaded with relations if needed
        const savedTransaction = await this.transactionsService.findById(transaction.id);

        // Create and save all assets
        await Promise.all(
          acquireReq.assets.map(async assetItem => {
            const asset = this.assetRepository.create({
              transaction: savedTransaction,
              type: AssetType.CNT, // Using CNT type for acquire
              policy_id: assetItem.policyId || '',
              asset_id: assetItem.assetName,
              quantity: assetItem.quantity,
              status: AssetStatus.PENDING,
              origin_type: AssetOriginType.ACQUIRED,
              added_by: user,
              metadata: assetItem?.metadata || {},
            });

            await this.assetRepository.save(asset);
          })
        );
      } catch (error) {
        this.logger.error(`Error creating assets for acquire transaction ${transaction.id}:`, error);
        throw new BadRequestException('Failed to create assets for the transaction');
      }
    }

    return {
      success: true,
      message: 'Acquire request accepted, transaction created',
      vaultId,
      txId: transaction.id,
      assets: acquireReq.assets,
    };
  }

  async updateTransactionHash(transactionId: string, txHash: string) {
    const transaction = await this.transactionsService.findById(transactionId);
    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    await this.transactionsService.updateTransactionHash(transactionId, txHash);
    return {
      success: true,
      message: 'Transaction hash updated',
      txId: transactionId,
      txHash: txHash,
    };
  }
}
