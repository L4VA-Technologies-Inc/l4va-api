import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InvestReq } from './dto/invest.req';
import { Vault } from "../../database/vault.entity";
import { VaultStatus } from "../../types/vault.types";
import { User } from "../../database/user.entity";
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../types/transaction.types';

@Injectable()
export class InvestmentService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly transactionsService: TransactionsService,
  ) {}

  async invest(vaultId: string, investReq: InvestReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['investors_whitelist', 'owner'],
    });

    const user = await this.userRepository.findOne({
      where: { id: userId },
    });


    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.investment) {
      throw new BadRequestException('Vault is not in investment phase');
    }

    // Allow vault owner to bypass whitelist check
    if (vault.owner.id !== userId) {
      // Check whitelist only for non-owners
      if (vault.investors_whitelist?.length > 0) {
        const isWhitelisted = vault.investors_whitelist.some(
          (entry) => entry.wallet_address === user.address,
        );
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in investor whitelist');
        }
      }
    }

    // Validate investment amount and currency based on vault settings
    if (vault.valuation_type === 'fixed') {
      if (investReq.currency !== vault.valuation_currency) {
        throw new BadRequestException('Invalid investment currency');
      }
      // Additional validation for fixed valuation type can be added here
    }

    // Create a transaction record for the investment
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.investment,
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
