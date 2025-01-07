import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Buffer } from 'buffer';
import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import { Ed25519Signature, PublicKey, Address, RewardAddress } from '@emurgo/cardano-serialization-lib-nodejs';
import { generateUsername } from 'unique-username-generator';

import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async verifySignature(signatureData: {
    signature: any;
    stakeAddress: string;
  }) {
    try {
      const { signature, stakeAddress } = signatureData;

      // Your existing signature verification code...
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

      // Find user in database
      let user = await this.usersService.findByAddress(signerStakeAddrBech32);

      // If user doesn't exist, create a new one
      if (!user) {
        try {
          user = await this.usersService.create({
            address: signerStakeAddrBech32,
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

      return {
        success: true,
        message: '✅ Authentication success!',
        accessToken: await this.jwtService.signAsync(jwtPayload),
        user: {
          id: user.id,
          name: user.name,
          address: user.address
        }
      };

    } catch (error) {
      console.error('Verification error:', error);
      return {
        success: false,
        message: error.message || 'Authentication failed',
      };
    }
  }
}
