import { Buffer } from 'buffer';

import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import { Ed25519Signature, PublicKey, Address, RewardAddress } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Brackets, Repository } from 'typeorm';
import { generateUsername } from 'unique-username-generator';
import { createPublicClient, defineChain, getAddress, http, isAddress, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';

import { PriceService } from '../price/price.service';
import { UsersService } from '../users/users.service';

import { LoginReq } from './dto/login.req';
import { LoginRes } from './dto/login.res';

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
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const evmChallengeKey = (address: string): string => `auth:evm-challenge:${address.toLowerCase()}`;

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

  /**
   * Issue a single-use login message for an EVM wallet. Only the latest message
   * per address is valid, it expires after EVM_CHALLENGE_TTL_SECONDS and is
   * consumed by the first login attempt, so a captured signature cannot be replayed.
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
    await this.redis.set(evmChallengeKey(walletAddress), message, 'EX', EVM_CHALLENGE_TTL_SECONDS);
    return { message };
  }

  private async verifyEvmLogin(walletAddress: string, signature: string): Promise<boolean> {
    if (!isAddress(walletAddress) || !signature) return false;

    // Consume the challenge before verifying so every message gets exactly one attempt
    const key = evmChallengeKey(walletAddress);
    const [[, message]] = (await this.redis.multi().get(key).del(key).exec()) as [[Error | null, string | null]];
    if (!message) return false;

    // publicClient.verifyMessage covers EOAs as well as smart-contract wallets (EIP-1271/6492)
    return this.getEvmPublicClient().verifyMessage({
      address: getAddress(walletAddress),
      message,
      signature: signature as Hex,
    });
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
      this.evmPublicClient = createPublicClient({ chain, transport: http(rpcUrl) });
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

      const signerStakeAddrBech32 = RewardAddress.from_address(address).to_address().to_bech32();

      const utf8Payload = Buffer.from(payload).toString('utf8');
      const expectedMessage = `account: ${signerStakeAddrBech32}`;

      const isVerified = publicKey.verify(signedData, sig);
      const messageMatches = utf8Payload === expectedMessage;
      const addressMatches = signerStakeAddrBech32 === stakeAddress;

      if (!isVerified || !messageMatches || !addressMatches) {
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
