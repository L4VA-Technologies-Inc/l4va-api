import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InvestReq } from './dto/invest.req';
import {Vault} from "../../database/vault.entity";
import {VaultStatus} from "../../types/vault.types";
import {User} from "../../database/user.entity";

@Injectable()
export class InvestmentService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

  ) {}

  async invest(vaultId: string, investReq: InvestReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['investorWhitelist'],
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

    // Check if user is in investor whitelist if vault has one
    if (vault.investors_whitelist?.length > 0) {
      const isWhitelisted = vault.investors_whitelist.some(
        (entry) => entry.wallet_address === user.address,
      );
      if (!isWhitelisted) {
        throw new BadRequestException('User is not in investor whitelist');
      }
    }

    // Validate investment amount and currency based on vault settings
    if (vault.valuation_type === 'fixed') {
      if (investReq.currency !== vault.valuation_currency) {
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
