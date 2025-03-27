import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InvestReq } from './dto/invest.req';
import { Vault } from '../vaults/entities/vault.entity';
import { VaultStatus } from '../vaults/types';

@Injectable()
export class InvestmentService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
  ) {}

  async invest(vaultId: string, investReq: InvestReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['investorWhitelist'],
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.status !== VaultStatus.INVESTMENT) {
      throw new BadRequestException('Vault is not in investment phase');
    }

    // Check if user is in investor whitelist if vault has one
    if (vault.investorWhitelist?.length > 0) {
      const isWhitelisted = vault.investorWhitelist.some(
        (entry) => entry.user_id === userId,
      );
      if (!isWhitelisted) {
        throw new BadRequestException('User is not in investor whitelist');
      }
    }

    // Validate investment amount and currency based on vault settings
    if (vault.valuationType === 'fixed') {
      if (investReq.currency !== vault.valuationCurrency) {
        throw new BadRequestException('Invalid investment currency');
      }
      // Additional validation for fixed valuation type can be added here
    }

    // TODO: Implement blockchain integration for investment transaction
    // This will be implemented when blockchain module is ready
    // For now, just return success
    return {
      success: true,
      message: 'Investment request accepted',
      vaultId,
      investorId: userId,
      amount: investReq.amount,
      currency: investReq.currency,
    };
  }
}
