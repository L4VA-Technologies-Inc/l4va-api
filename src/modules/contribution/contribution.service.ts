import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {ContributeReq} from './dto/contribute.req';
import {Vault} from "../../database/vault.entity";
import {User} from "../../database/user.entity";
import {VaultStatus} from "../../types/vault.types";

@Injectable()
export class ContributionService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>
  ) {}

  async contribute(vaultId: string, contributeReq: ContributeReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['contributor_whitelist'],
    });
    const user = await this.usersRepository.findOne({
      where: { id: userId }
    });


    if(!user){
      throw new NotFoundException("User not found");
    }

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Vault is not in contribution phase');
    }

    // Check if user is in contributor whitelist if vault has one
    if (vault.contributor_whitelist?.length > 0) {
      const isWhitelisted = vault.contributor_whitelist.some(
        (entry) => entry.wallet_address === user.address,
      );
      if (!isWhitelisted) {
        throw new BadRequestException('User is not in contributor whitelist');
      }
    }

    // TODO: Implement blockchain integration for asset contribution
    // This will be implemented when blockchain module is ready
    // For now, just return success
    return {
      success: true,
      message: 'Contribution request accepted',
      vaultId,
      contributorAddress: user.address,
      assets: contributeReq.assets,
    };
  }
}
