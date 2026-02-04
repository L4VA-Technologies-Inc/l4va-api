import { Buffer } from 'buffer';

import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import { Ed25519Signature, PublicKey, Address, RewardAddress } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { generateUsername } from 'unique-username-generator';

import { PriceService } from '../price/price.service';
import { UsersService } from '../users/users.service';

import { LoginReq } from './dto/login.req';
import { LoginRes } from './dto/login.res';

import { Vault } from '@/database/vault.entity';
import { transformImageToUrl } from '@/helpers';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private readonly priceService: PriceService,
    @InjectRepository(Vault)
    private vaultRepository: Repository<Vault>
  ) {}

  async verifySignature(signatureData: LoginReq): Promise<LoginRes> {
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
      let user = await this.usersService.findByAddress(stakeAddress);

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
