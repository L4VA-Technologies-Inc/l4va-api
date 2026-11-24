import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LinkedWalletRes } from './dto/linked-wallet.res';

import { User } from '@/database/user.entity';
import { ChainType } from '@/types/vault.types';

/**
 * Wallets are linked across chains by sharing the same verified email.
 * Rules: at most one wallet per chain per verified email (1 Cardano <-> 1 Robinhood),
 * enforced here for friendly errors and by the IDX_users_verified_email_chain unique index.
 */
@Injectable()
export class WalletLinkService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>
  ) {}

  /**
   * Throws if another wallet of the same chain already holds this email as verified.
   */
  async assertEmailAvailable(user: Pick<User, 'id' | 'chain_type'>, email: string): Promise<void> {
    const conflict = await this.usersRepository
      .createQueryBuilder('user')
      .select('user.id')
      .where('LOWER(user.email) = LOWER(:email)', { email })
      .andWhere('user.email_verified = true')
      .andWhere('user.deleted = false')
      .andWhere('user.chain_type = :chainType', { chainType: user.chain_type })
      .andWhere('user.id != :userId', { userId: user.id })
      .getOne();

    if (conflict) {
      throw new ConflictException(
        `This email is already linked to another ${user.chain_type} wallet. Unlink that wallet first.`
      );
    }
  }

  /**
   * Returns all wallets sharing the user's verified email, including the user's own wallet.
   * A user without a verified email only gets their own wallet back.
   */
  async getLinkedWallets(userId: string): Promise<LinkedWalletRes[]> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const wallets =
      user.email && user.email_verified
        ? await this.usersRepository
            .createQueryBuilder('user')
            .where('LOWER(user.email) = LOWER(:email)', { email: user.email })
            .andWhere('user.email_verified = true')
            .andWhere('user.deleted = false')
            .orderBy('user.chain_type', 'ASC')
            .getMany()
        : [user];

    return wallets.map(wallet => ({
      userId: wallet.id,
      address: wallet.address,
      chainType: wallet.chain_type ?? ChainType.cardano,
      isCurrent: wallet.id === userId,
    }));
  }

  /**
   * Unlinks a wallet from the user's email group by clearing its email.
   * The caller may unlink its own wallet or any wallet sharing its verified email.
   */
  async unlinkWallet(userId: string, targetUserId: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    const linked = await this.getLinkedWallets(userId);
    const target = linked.find(wallet => wallet.userId === targetUserId);

    if (!target) {
      throw new NotFoundException('Wallet is not linked to your account');
    }
    if (linked.length < 2) {
      throw new BadRequestException('Wallet has no linked wallets');
    }

    // Conditional update: skip if the target changed its email after the lookup above
    const { affected } = await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        email: null,
        email_verified: false,
        email_verification_token_hash: null,
        email_verification_expires_at: null,
        email_verification_sent_at: null,
      })
      .where('id = :targetUserId', { targetUserId })
      .andWhere('LOWER(email) = LOWER(:email)', { email: user.email })
      .andWhere('email_verified = true')
      .andWhere('deleted = false')
      .execute();

    if (!affected) {
      throw new ConflictException('Wallet link has changed, please refresh and try again');
    }
  }
}
