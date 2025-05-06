import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AcquireReq } from './dto/acquire.req';
import { Vault } from '../../database/vault.entity';
import { VaultStatus } from '../../types/vault.types';
import { User } from '../../database/user.entity';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../types/transaction.types';

@Injectable()
export class AcquireService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly transactionsService: TransactionsService,
  ) {}

  async invest(vaultId: string, investReq: AcquireReq, userId: string) {
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

    // Allow vault owner to bypass whitelist check
    if (vault.owner.id !== userId) {
      // Check whitelist only for non-owners
      if (vault.acquirer_whitelist?.length > 0) {
        const isWhitelisted = vault.acquirer_whitelist.some(
          (entry) => entry.wallet_address === user.address,
        );
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in investor whitelist');
        }
      }
    }

    // Validate acquire amount and currency based on vault settings
    if (vault.value_method === 'fixed') {
      if (investReq.currency !== vault.valuation_currency) {
        throw new BadRequestException('Invalid acquire currency');
      }
      // Additional validation for fixed valuation type can be added here
    }

    // Create a transaction record for the acquire
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.acquire,
      assets: [], // Investment transactions don't have assets, only ADA amount
      amount: parseFloat(investReq.amount)
    });

    return {
      success: true,
      message: 'Investment request accepted, transaction created',
      vaultId,
      txId: transaction.id,
      amount: investReq.amount,
      currency: investReq.currency,
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
