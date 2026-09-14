import { createHash, randomBytes } from 'crypto';

import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '@/database/user.entity';
import { NotificationService } from '@/modules/notification/notification.service';

const TOKEN_TTL_HOURS = 24;
const RESEND_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly appUrl: string;

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService
  ) {
    // CLIENT_APP_URL lets local setups point the verification link at e.g. http://localhost:5173
    this.appUrl =
      this.configService.get<string>('CLIENT_APP_URL')?.replace(/\/+$/, '') ||
      (this.configService.get<string>('CARDANO_NETWORK') === 'mainnet'
        ? 'https://app.l4va.org'
        : 'https://testnet.l4va.org');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generates a fresh token (invalidating any previous link) and sends the verification email via Novu.
   */
  async sendVerification(user: Pick<User, 'id' | 'email' | 'name' | 'address'>): Promise<void> {
    if (!user.email) {
      throw new BadRequestException('User has no email');
    }

    const token = randomBytes(32).toString('hex');

    await this.usersRepository.update(
      { id: user.id },
      {
        email_verified: false,
        email_verification_token_hash: this.hashToken(token),
        email_verification_expires_at: new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000),
      }
    );

    await this.notificationService.sendEmailVerification({
      email: user.email,
      address: user.address,
      firstName: user.name,
      verificationUrl: `${this.appUrl}/verify-email?token=${token}`,
      expiresInHours: TOKEN_TTL_HOURS,
    });

    // Only start the resend cooldown once Novu actually accepted the email
    await this.usersRepository.update({ id: user.id }, { email_verification_sent_at: new Date() });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.email_verification_sent_at')
      .where('user.id = :userId', { userId })
      .getOne();

    if (!user) {
      throw new BadRequestException('User not found');
    }
    if (!user.email) {
      throw new BadRequestException('Add an email to your profile first');
    }
    if (user.email_verified) {
      throw new BadRequestException('Email is already verified');
    }

    const sentAt = user.email_verification_sent_at?.getTime();
    if (sentAt && Date.now() - sentAt < RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - sentAt)) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Please wait ${retryAfterSeconds}s before requesting another email`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    try {
      await this.sendVerification(user);
    } catch (error) {
      this.logger.error(`Failed to send verification email to user ${userId}: ${error?.message || error}`);
      throw new HttpException('Failed to send verification email', HttpStatus.BAD_GATEWAY);
    }
  }

  async verify(token: string): Promise<{ email: string; emailVerified: boolean }> {
    const user = await this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.email_verification_expires_at')
      .where('user.email_verification_token_hash = :hash', { hash: this.hashToken(token) })
      .getOne();

    if (!user || !user.email) {
      throw new BadRequestException('Verification link is invalid or has already been used');
    }
    if (!user.email_verification_expires_at || user.email_verification_expires_at.getTime() < Date.now()) {
      throw new BadRequestException('Verification link has expired');
    }

    await this.usersRepository.update(
      { id: user.id },
      {
        email_verified: true,
        email_verification_token_hash: null,
        email_verification_expires_at: null,
      }
    );

    return { email: user.email, emailVerified: true };
  }
}
