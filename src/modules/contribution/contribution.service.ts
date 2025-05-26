import {BadRequestException, Inject, Injectable, Logger, NotFoundException, forwardRef} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {ContributeReq} from './dto/contribute.req';
import {Vault} from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {VaultPrivacy, VaultStatus} from '../../types/vault.types';
import {TransactionsService} from '../transactions/transactions.service';
import {TransactionStatus, TransactionType} from '../../types/transaction.types';
import {Asset} from '../../database/asset.entity';
import {AssetStatus, AssetType, AssetOriginType} from '../../types/asset.types';
import {Transaction} from '../../database/transaction.entity';
import {BlockchainScannerService} from '../blockchain/blockchain-scanner.service';
import {BlockchainTransactionResponse, BlockchainTransactionListItem} from '../../types/blockchain.types';

@Injectable()
export class ContributionService {
  private readonly logger = new Logger(ContributionService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    private readonly blockchainScanner: BlockchainScannerService,
  ) {}

  /**
   * Syncs contribution transactions for a vault by comparing on-chain transactions
   * with the transactions stored in the database
   * @param vaultId - The ID of the vault to sync transactions for
   * @returns An object containing processed blockchain transactions and database transactions
   */
  async syncContributionTransactions(vaultId: string): Promise<{
    processedBlockchainTxs: Array<{
      tx: BlockchainTransactionListItem;
      dbTx: Transaction | null;
      statusUpdated: boolean;
    }>;
    databaseTxs: Transaction[];
  }> {
    try {
      // Get the vault with contract address
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'contract_address']
      });

      if (!vault) {
        throw new NotFoundException('Vault not found');
      }

      if (!vault.contract_address) {
        throw new BadRequestException('Vault does not have a contract address');
      }

      // Get transactions from blockchain and process them
      const blockchainTxs = await this.blockchainScanner.getAddressTransactions(vault.contract_address);

      // Process blockchain transactions
      const processedBlockchainTxs = await Promise.all(
        blockchainTxs
          // Filter out transactions without block height
          .filter(tx => tx.block_height != null)
          // Process each transaction
          .map(async (tx) => {
            // Find corresponding transaction in database
            const dbTx = await this.transactionRepository.findOne({
              where: { tx_hash: tx.tx_hash }
            });

            let statusUpdated = false;

            // If transaction exists in DB and status is not confirmed, update it
            if (dbTx && dbTx.status !== 'confirmed') {
              try {
                await this.transactionsService.updateTransactionStatus(
                  tx.tx_hash,
                  'confirmed' as TransactionStatus
                );
                statusUpdated = true;
                this.logger.log(`Updated transaction ${tx.tx_hash} status to confirmed`);
              } catch (updateError) {
                this.logger.error(
                  `Failed to update transaction ${tx.tx_hash} status`,
                  updateError
                );
              }
            }

            return {
              tx,
              dbTx: dbTx || null,
              statusUpdated
            };
          })
      );

      // Get all transactions from database for this vault
      const databaseTxs = await this.transactionRepository.find({
        where: {
          vault_id: vaultId,
          type: TransactionType.contribute,
        },
        order: {
          id: 'DESC' as const, // Using id as a proxy for creation order
        },
      });

      return {
        processedBlockchainTxs,
        databaseTxs,
      };
    } catch (error) {
      this.logger.error(`Failed to sync contribution transactions for vault ${vaultId}`, error);
      throw error;
    }
  }

  async contribute(vaultId: string, contributeReq: ContributeReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['contributor_whitelist', 'owner', 'assets_whitelist'],
    });
    const user = await this.usersRepository.findOne({
      where: { id: userId }
    });


    if(!user){
      throw new NotFoundException('User not found');
    }

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Vault is not in contribution phase');
    }

    // For private/semi-private vaults, validate assets against whitelist
    if ((vault.privacy === VaultPrivacy.private || vault.privacy === VaultPrivacy.semiPrivate) && contributeReq.assets.length > 0) {
      const invalidAssets = contributeReq.assets.filter(asset => {
        return !vault.assets_whitelist?.some(whitelistedAsset =>
          whitelistedAsset.policy_id === asset.policyId
        );
      });

      if (invalidAssets.length > 0) {
        throw new BadRequestException(`Some assets are not in the vault's whitelist: ${invalidAssets.map(a => a.policyId).join(', ')}`);
      }
    }

    // Allow vault owner to bypass whitelist check
    if (vault.owner.id !== userId) {
      // Check whitelist only for non-owners
      if (vault.contributor_whitelist?.length > 0) {
        const isWhitelisted = vault.contributor_whitelist.some(
          (entry) => entry.wallet_address === user.address,
        );
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in contributor whitelist');
        }
      }
    }
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.contribute,
      assets: []
    });
    if (contributeReq.assets.length > 0) {
      try {
        // First, ensure the transaction exists and is loaded with relations if needed
        const savedTransaction = await this.transactionRepository.findOneOrFail({
          where: { id: transaction.id },
          relations: ['assets']
        });

        // Create and save all assets
        const assets = await Promise.all(
          contributeReq.assets.map(async (assetItem) => {
            const asset = this.assetRepository.create({
              transaction: savedTransaction,
              type: AssetType.NFT,
              policy_id: assetItem.policyId || '',
              asset_id: assetItem.assetName,
              quantity: assetItem.quantity,
              status: AssetStatus.PENDING,
              origin_type: AssetOriginType.CONTRIBUTED,
              added_by: user,
              metadata: assetItem?.metadata || {}
            });

            const savedAsset = await this.assetRepository.save(asset);
            this.logger.log(`Created asset ${savedAsset.id} for transaction ${savedTransaction.id}`);
            return savedAsset;
          })
        );

        this.logger.log(`Successfully created ${assets.length} assets for transaction ${savedTransaction.id}`);
      } catch (error) {
        this.logger.error(`Failed to save assets for transaction ${transaction.id}`, error);
        throw new Error(`Failed to save contribution assets: ${error.message}`);
      }
    }
    return {
      success: true,
      message: 'Contribution request accepted, transaction created',
      vaultId,
      txId: transaction.id,
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
      txHash: txHash
    };
  }




}
