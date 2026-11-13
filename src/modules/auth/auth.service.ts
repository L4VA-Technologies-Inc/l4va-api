import { Buffer } from 'buffer';
import { randomBytes } from 'crypto';

import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import {
  Ed25519Signature,
  PublicKey,
  Address,
  BaseAddress,
  RewardAddress,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Brackets, Repository } from 'typeorm';
import { generateUsername } from 'unique-username-generator';
import {
  createPublicClient,
  defineChain,
  getAddress,
  isAddress,
  isAddressEqual,
  recoverMessageAddress,
  type Hex,
} from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';

import { PriceService } from '../price/price.service';
import { UsersService } from '../users/users.service';

import { LoginReq } from './dto/login.req';
import { LoginRes } from './dto/login.res';

import { buildEvmTransport } from '@/common/evm/evm-transport';
import { Vault } from '@/database/vault.entity';
import { transformImageToUrl } from '@/helpers';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';
import { ChainType, VaultStatus } from '@/types/vault.types';

const EVM_CHALLENGE_TTL_SECONDS = 300;
// Frontends allowed to request a sign-in message; the wallet shows this domain and
// warns when it does not match the site asking for the signature.
const DEFAULT_SIWE_ORIGINS = [
  'https://app.l4va.org',
  'https://testnet.l4va.org',
  'https://testnet-29272671.l4va.org',
  'https://stage-755289.l4va.org',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const CARDANO_CHALLENGE_TTL_SECONDS = 300;
// Challenges live in a sorted set per address (member = message, score = expiry in ms), so a new
// challenge never replaces one a user is still signing: anyone can request a challenge for any
// public address, and with "latest wins" that let a third party keep a victim's login failing.
const MAX_ACTIVE_CHALLENGES = 20;
// Smart-contract wallets cannot be matched by local ecrecover; each candidate costs an RPC call
const MAX_CONTRACT_WALLET_CANDIDATES = 3;
const CHALLENGE_RATE_LIMIT = 20; // challenge requests per IP per window
const CHALLENGE_RATE_WINDOW_SECONDS = 60;
const cardanoChallengeKey = (stakeAddress: string): string => `auth:cardano-challenges:${stakeAddress}`;
const evmChallengeKey = (address: string): string => `auth:evm-challenges:${address.toLowerCase()}`;
const challengeRateKey = (ip: string): string => `auth:challenge-rate:${ip}`;

@Injectable()
export class AuthService {
  private evmPublicClient: ReturnType<typeof createPublicClient> | null = null;

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private readonly priceService: PriceService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectRepository(Vault)
    private vaultRepository: Repository<Vault>
  ) {}

  /** Throttle challenge requests per client IP so nobody can flood the challenge sets. */
  async assertChallengeRateLimit(ip: string | undefined): Promise<void> {
    const key = challengeRateKey(ip || 'unknown');
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, CHALLENGE_RATE_WINDOW_SECONDS, 'NX')
      .exec()) as [[Error | null, number]];
    if (count > CHALLENGE_RATE_LIMIT) {
      throw new HttpException('Too many sign-in requests, try again in a minute', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Add a challenge to the address's set; expired and overflow (oldest) entries are dropped. */
  private async storeChallenge(key: string, message: string, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', now)
      .zadd(key, now + ttlSeconds * 1000, message)
      .zremrangebyrank(key, 0, -(MAX_ACTIVE_CHALLENGES + 1))
      .expire(key, ttlSeconds)
      .exec();
  }

  /** Unexpired challenges for an address, newest first. */
  private async activeChallenges(key: string): Promise<string[]> {
    return this.redis.zrevrangebyscore(key, '+inf', Date.now());
  }

  /**
   * Atomically take one challenge out of the set. True only for the caller that removed it while it
   * was still valid, so each message logs in at most once.
   */
  private async consumeChallenge(key: string, message: string): Promise<boolean> {
    const [[, score], [, removed]] = (await this.redis.multi().zscore(key, message).zrem(key, message).exec()) as [
      [Error | null, string | null],
      [Error | null, number],
    ];
    return removed === 1 && score !== null && Number(score) > Date.now();
  }

  /**
   * Issue a single-use login message for an EVM wallet. Several may be active per address; each
   * expires after EVM_CHALLENGE_TTL_SECONDS and is consumed by the login that uses it, so a
   * captured signature cannot be replayed.
   */
  async createEvmChallenge(walletAddress: string, origin: string | undefined): Promise<{ message: string }> {
    const allowedOrigins =
      this.configService
        .get<string>('SIWE_ALLOWED_ORIGINS')
        ?.split(',')
        .map(o => o.trim())
        .filter(Boolean) ?? DEFAULT_SIWE_ORIGINS;
    if (!origin || !allowedOrigins.includes(origin)) {
      throw new BadRequestException('Sign-in is not allowed from this origin');
    }

    const now = new Date();
    const { host } = new URL(origin);
    const message = createSiweMessage({
      domain: host,
      address: getAddress(walletAddress),
      statement: 'Sign in to L4VA',
      uri: origin,
      version: '1',
      chainId: Number(this.configService.get<number>('EVM_CHAIN_ID', 46630)),
      nonce: generateSiweNonce(),
      issuedAt: now,
      expirationTime: new Date(now.getTime() + EVM_CHALLENGE_TTL_SECONDS * 1000),
    });
    await this.storeChallenge(evmChallengeKey(walletAddress), message, EVM_CHALLENGE_TTL_SECONDS);
    return { message };
  }

  /**
   * Issue a single-use CIP-30 signData message for a Cardano stake address. Same rules as
   * the EVM challenge: several may be active, each expires after CARDANO_CHALLENGE_TTL_SECONDS
   * and is consumed by the login that uses it.
   */
  async createCardanoChallenge(stakeAddress: string): Promise<{ message: string }> {
    let reward: RewardAddress | undefined;
    try {
      reward = RewardAddress.from_address(Address.from_bech32(stakeAddress));
    } catch {
      reward = undefined;
    }
    if (!reward) throw new BadRequestException('Invalid stake address');

    const issuedAt = new Date();
    const message = [
      'Sign in to L4VA',
      `account: ${stakeAddress}`,
      `nonce: ${randomBytes(16).toString('hex')}`,
      `issued: ${issuedAt.toISOString()}`,
      `expires: ${new Date(issuedAt.getTime() + CARDANO_CHALLENGE_TTL_SECONDS * 1000).toISOString()}`,
    ].join('\n');
    await this.storeChallenge(cardanoChallengeKey(stakeAddress), message, CARDANO_CHALLENGE_TTL_SECONDS);
    return { message };
  }

  private async verifyEvmLogin(walletAddress: string, signature: string): Promise<boolean> {
    if (!isAddress(walletAddress) || !signature) return false;

    // The login request carries only the signature, so find which active challenge it signs
    const key = evmChallengeKey(walletAddress);
    const candidates = await this.activeChallenges(key);
    if (!candidates.length) return false;
    const address = getAddress(walletAddress);

    // EOAs: local ecrecover, no RPC
    let signed: string | undefined;
    for (const message of candidates) {
      try {
        if (isAddressEqual(await recoverMessageAddress({ message, signature: signature as Hex }), address)) {
          signed = message;
          break;
        }
      } catch {
        break; // not an ECDSA signature: a smart-contract wallet, checked below
      }
    }

    // Smart-contract wallets (EIP-1271/6492) need the chain; only the newest few to cap RPC calls
    if (!signed) {
      const client = this.getEvmPublicClient();
      for (const message of candidates.slice(0, MAX_CONTRACT_WALLET_CANDIDATES)) {
        const ok = await client
          .verifyMessage({ address, message, signature: signature as Hex })
          .catch((): boolean => false);
        if (ok) {
          signed = message;
          break;
        }
      }
    }

    return !!signed && (await this.consumeChallenge(key, signed));
  }

  private getEvmPublicClient(): ReturnType<typeof createPublicClient> {
    if (!this.evmPublicClient) {
      const rpcUrl = this.configService.get<string>('EVM_RPC_URL');
      const chain = defineChain({
        id: Number(this.configService.get<number>('EVM_CHAIN_ID', 46630)),
        name: 'Robinhood',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      this.evmPublicClient = createPublicClient({ chain, transport: buildEvmTransport(this.configService, rpcUrl) });
    }
    return this.evmPublicClient;
  }

  async login(payload: LoginReq): Promise<LoginRes> {
    payload.chainType ??= ChainType.cardano;
    if (payload.chainType === ChainType.cardano) {
      return await this.handleCardano(payload);
    }
    if (payload.chainType === ChainType.robinhood) {
      return await this.handleRobinhood(payload);
    }
  }

  async handleRobinhood(payload: LoginReq): Promise<LoginRes> {
    const { walletAddress, chainType } = payload;

    let isVerified = false;
    try {
      isVerified = await this.verifyEvmLogin(walletAddress, payload.evmSignature);
    } catch {
      isVerified = false;
    }
    if (!isVerified) {
      return {
        success: false,
        message: 'Signature verification failed',
      };
    }

    // Find user in database by wallet address
    let user = await this.usersService.findByAddress(walletAddress);

    if (!user) {
      try {
        user = await this.usersService.create({
          address: walletAddress,
          stake_address: null,
          name: generateUsername(),
          chain_type: chainType,
        });
      } catch (error) {
        console.error('Error creating new user:', error);
        return {
          success: false,
          message: 'Failed to create new user',
        };
      }
    }
    if (!user?.address || user?.address?.includes('stake1')) {
      await this.usersService.updateUserAddress(user.id, walletAddress);
    }
    // Generate JWT token
    const jwtPayload = {
      sub: user.id,
      address: user.address,
      name: user.name,
    };

    const profileImage = transformImageToUrl(user.profile_image);
    const bannerImage = transformImageToUrl(user.banner_image);

    const statuses = [
      VaultStatus.published,
      VaultStatus.contribution,
      VaultStatus.acquire,
      VaultStatus.locked,
      VaultStatus.burned,
    ];
    const vaultsCount = await this.vaultRepository
      .createQueryBuilder('vault')
      .andWhere('vault.deleted != :deleted', { deleted: true })
      .andWhere('vault.vault_status IN (:...statuses)', { statuses })
      .andWhere(
        new Brackets(qb => {
          qb.where('vault.owner_id = :userId', { userId: user.id })
            .orWhere(
              `EXISTS (
            SELECT 1 FROM assets
            WHERE assets.vault_id = vault.id 
            AND assets.added_by = :userId
            AND assets.status IN ('locked', 'distributed')
          )`,
              { userId: user.id }
            )
            .orWhere(
              `EXISTS (
            SELECT 1 FROM snapshot
            WHERE snapshot.vault_id = vault.id 
            AND snapshot.address_balances -> :userAddress IS NOT NULL
            ORDER BY snapshot.created_at DESC
            LIMIT 1
          )`,
              { userAddress: user.address }
            );
        })
      )
      .getCount();
    user.total_vaults = vaultsCount || 0;

    return {
      success: true,
      message: '✅ Authentication success!',
      accessToken: await this.jwtService.signAsync(jwtPayload),
      user: {
        id: user.id,
        name: user.name,
        address: user.address,
        description: user.description,
        totalValueUsd: parseFloat((user.tvl * (await this.priceService.getAdaPrice())).toFixed(2)),
        totalValueAda: user.tvl,
        totalVaults: user.total_vaults,
        gains: user.gains,
        profileImage: profileImage,
        bannerImage: bannerImage,
        email: user.email,
        emailVerified: user.email_verified,
      },
    };
  }

  async handleCardano(signatureData: LoginReq): Promise<LoginRes> {
    try {
      const { signature, stakeAddress, walletAddress } = signatureData;

      // Verify the signature
      const decoded = COSESign1.from_bytes(Buffer.from(signature.signature, 'hex'));
      const headermap = decoded.headers().protected().deserialized_headers();
      const addressHex = Buffer.from(headermap.header(Label.new_text('address')).to_bytes())
        .toString('hex')
        .substring(4);
      const address = Address.from_bytes(Buffer.from(addressHex, 'hex'));

      const key = COSEKey.from_bytes(Buffer.from(signature.key, 'hex'));
      const pubKeyBytes = key.header(Label.new_int(Int.new_negative(BigNum.from_str('2')))).as_bytes();
      const publicKey = PublicKey.from_bytes(pubKeyBytes);

      const payload = decoded.payload();
      const sig = Ed25519Signature.from_bytes(decoded.signature());
      const signedData = decoded.signed_data().to_bytes();

      // C-1: the COSE key must actually own the stake credential of the signing address,
      // otherwise anyone can sign with their own key while claiming someone else's address.
      const reward = RewardAddress.from_address(address);
      const stakeKeyHash = reward?.payment_cred().to_keyhash();
      const keyOwnsAddress = !!stakeKeyHash && stakeKeyHash.to_hex() === publicKey.hash().to_hex();
      const signerStakeAddrBech32 = reward?.to_address().to_bech32();
      const addressMatches = !!signerStakeAddrBech32 && signerStakeAddrBech32 === stakeAddress;

      // walletAddress is stored as the user's address, so it must sit on the same stake key
      const walletStakeHash = ((): string | undefined => {
        try {
          return BaseAddress.from_address(Address.from_bech32(walletAddress))?.stake_cred().to_keyhash()?.to_hex();
        } catch {
          return undefined;
        }
      })();
      const walletMatches = !!walletStakeHash && walletStakeHash === stakeKeyHash?.to_hex();

      const utf8Payload = payload ? Buffer.from(payload).toString('utf8') : '';
      const isVerified = publicKey.verify(signedData, sig);

      // Server-issued single-use challenge: the signed payload must be one of the address's active
      // challenges. Consumed only once everything else checks out, so a bad attempt cannot burn it.
      const messageMatches =
        isVerified &&
        keyOwnsAddress &&
        addressMatches &&
        walletMatches &&
        !!utf8Payload &&
        (await this.consumeChallenge(cardanoChallengeKey(stakeAddress), utf8Payload));

      if (!isVerified || !keyOwnsAddress || !messageMatches || !addressMatches || !walletMatches) {
        return {
          success: false,
          message: 'Signature verification failed',
        };
      }

      // Find user in database by wallet address
      let user = await this.usersService.findByStakeAddress(stakeAddress);

      if (!user) {
        try {
          user = await this.usersService.create({
            address: walletAddress,
            stake_address: stakeAddress,
            name: generateUsername(),
          });
        } catch (error) {
          console.error('Error creating new user:', error);
          return {
            success: false,
            message: 'Failed to create new user',
          };
        }
      }
      if (!user?.address || user?.address?.includes('stake1')) {
        await this.usersService.updateUserAddress(user.id, walletAddress);
      }
      // Generate JWT token
      const jwtPayload = {
        sub: user.id,
        address: user.address,
        name: user.name,
      };

      const profileImage = transformImageToUrl(user.profile_image);
      const bannerImage = transformImageToUrl(user.banner_image);

      const statuses = [
        VaultStatus.published,
        VaultStatus.contribution,
        VaultStatus.acquire,
        VaultStatus.locked,
        VaultStatus.burned,
      ];
      const vaultsCount = await this.vaultRepository
        .createQueryBuilder('vault')
        .andWhere('vault.deleted != :deleted', { deleted: true })
        .andWhere('vault.vault_status IN (:...statuses)', { statuses })
        .andWhere(
          new Brackets(qb => {
            qb.where('vault.owner_id = :userId', { userId: user.id })
              .orWhere(
                `EXISTS (
              SELECT 1 FROM assets
              WHERE assets.vault_id = vault.id 
              AND assets.added_by = :userId
              AND assets.status IN ('locked', 'distributed')
            )`,
                { userId: user.id }
              )
              .orWhere(
                `EXISTS (
              SELECT 1 FROM snapshot
              WHERE snapshot.vault_id = vault.id 
              AND snapshot.address_balances -> :userAddress IS NOT NULL
              ORDER BY snapshot.created_at DESC
              LIMIT 1
            )`,
                { userAddress: user.address }
              );
          })
        )
        .getCount();
      user.total_vaults = vaultsCount || 0;

      return {
        success: true,
        message: '✅ Authentication success!',
        accessToken: await this.jwtService.signAsync(jwtPayload),
        user: {
          id: user.id,
          name: user.name,
          address: user.address,
          description: user.description,
          totalValueUsd: parseFloat((user.tvl * (await this.priceService.getAdaPrice())).toFixed(2)),
          totalValueAda: user.tvl,
          totalVaults: user.total_vaults,
          gains: user.gains,
          profileImage: profileImage,
          bannerImage: bannerImage,
          email: user.email,
          emailVerified: user.email_verified,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Authentication failed',
      };
    }
  }
}
