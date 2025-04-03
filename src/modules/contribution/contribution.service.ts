import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {ContributeReq} from './dto/contribute.req';
import {Vault} from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {VaultPrivacy, VaultStatus} from '../../types/vault.types';
import {TransactionsService} from '../transactions/transactions.service';
import {TransactionType} from '../../types/transaction.types';
import {Asset} from '../../database/asset.entity';
import {AssetStatus, AssetType} from '../../types/asset.types';

@Injectable()
export class ContributionService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly transactionsService: TransactionsService,
  ) {}

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
    if(contributeReq.assets.length > 0){
      contributeReq.assets.map(assetItem => {
        this.assetRepository.save({
          transaction: transaction,
          type: AssetType.NFT,
          policy_id: assetItem.policyId,
          asset_id: assetItem.assetId,
          quantity: assetItem.quantity,
          status: AssetStatus.PENDING,
          added_by: user
        });
      });
    }
    return {
      success: true,
      message: 'Contribution request accepted, transaction created',
      vaultId,
      tx_id: transaction.id,
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
      tx_id: transactionId,
      tx_hash: txHash
    };
  }
}
