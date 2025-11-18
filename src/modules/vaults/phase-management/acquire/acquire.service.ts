import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { ContributionAsset } from '../contribution/dto/contribute.req';

import { AcquireReq } from './dto/acquire.req';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AcquireService {
  private readonly PROTOCOL_ACQUIRERS_FEE: number;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService
  ) {
    this.PROTOCOL_ACQUIRERS_FEE = this.configService.get<number>('PROTOCOL_ACQUIRERS_FEE');
  }

  async acquire(
    vaultId: string,
    acquireReq: AcquireReq,
    userId: string
  ): Promise<{
    success: boolean;
    message: string;
    vaultId: string;
    txId: string;
    assets: ContributionAsset[];
  }> {
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
      amount: acquireReq.assets.reduce((sum, asset) => sum + (asset.quantity || 0), 0),
      assets: [],
      userId,
      fee: this.PROTOCOL_ACQUIRERS_FEE,
      metadata: acquireReq.assets,
    });

    return {
      success: true,
      message: 'Acquire request accepted, transaction created',
      vaultId,
      txId: transaction.id,
      assets: acquireReq.assets,
    };
  }
}
