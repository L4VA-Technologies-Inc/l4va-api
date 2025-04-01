import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Buffer } from 'buffer';
import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import {
  Ed25519Signature,
  PublicKey,
  Address,
  RewardAddress, BaseAddress
} from '@emurgo/cardano-serialization-lib-nodejs';
import { generateUsername } from 'unique-username-generator';

import { UsersService } from '../users/users.service';
import {LoginReq} from "./dto/login.req";
import {transformImageToUrl} from "../../helpers";

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async verifySignature(signatureData: LoginReq) {
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

      // If user doesn't exist, create a new one
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

      // Generate JWT token
      const jwtPayload = {
        sub: user.id,
        address: user.address,
        name: user.name
      };

      const profileImage = transformImageToUrl(user.profile_image);
      const bannerImage = transformImageToUrl(user.banner_image);

      return {
        success: true,
        message: '✅ Authentication success!',
        accessToken: await this.jwtService.signAsync(jwtPayload),
        user: {
          id: user.id,
          name: user.name,
          address: user.address,
          description: user.description,
          tvl: user.tvl,
          totalVaults: user.total_vaults,
          gains: user.gains,
          profileImage: profileImage,
          bannerImage: bannerImage,
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message || 'Authentication failed',
      };
    }
  }
}
