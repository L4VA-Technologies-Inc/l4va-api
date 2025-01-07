import { Injectable } from '@nestjs/common';
import { Buffer } from 'buffer';
import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import { Ed25519Signature, PublicKey, Address, RewardAddress } from '@emurgo/cardano-serialization-lib-nodejs';

@Injectable()
export class AuthService {
  private registeredUsers = [
    {
      address: 'stake1uxslhvvuu4utn7gcqv3rw66rfuj4vh9tlhl42cc96gjkw4gmym2rt',
      name: 'Yar'
    },
    {
      address: 'stake1u8wgsawfthlfc7t402p708dy9gseeek8u3ymrxhk63grhzsz5c4xk',
      name: 'Slav',
    }
  ];

  async verifySignature(signatureData: {
    signature: any;
    stakeAddress: string;
  }) {
    try {
      const { signature, stakeAddress } = signatureData;

      // Decode the signature
      const decoded = COSESign1.from_bytes(Buffer.from(signature.signature, 'hex'));

      // Extract signer's address from headers
      const headermap = decoded.headers().protected().deserialized_headers();
      const addressHex = Buffer.from(headermap.header(Label.new_text('address')).to_bytes())
        .toString('hex')
        .substring(4);
      const address = Address.from_bytes(Buffer.from(addressHex, 'hex'));

      // Get the public key
      const key = COSEKey.from_bytes(Buffer.from(signature.key, 'hex'));
      const pubKeyBytes = key.header(Label.new_int(Int.new_negative(BigNum.from_str('2')))).as_bytes();
      const publicKey = PublicKey.from_bytes(pubKeyBytes);

      // Get payload, signature and signed data
      const payload = decoded.payload();
      const sig = Ed25519Signature.from_bytes(decoded.signature());
      const signedData = decoded.signed_data().to_bytes();

      // Get the actual signer's stake address
      const signerStakeAddrBech32 = RewardAddress.from_address(address).to_address().to_bech32();

      // Reconstruct and verify expected message
      const utf8Payload = Buffer.from(payload).toString('utf8');
      const expectedMessage = `account: ${signerStakeAddrBech32}`;

      // Verify:
      const isVerified = publicKey.verify(signedData, sig);
      const messageMatches = utf8Payload === expectedMessage;
      const addressMatches = signerStakeAddrBech32 === stakeAddress;
      const isRegistered = this.registeredUsers.some(user => user.address === signerStakeAddrBech32);

      // Check all conditions
      if (!isVerified) {
        return {
          success: false,
          message: 'Invalid signature',
        };
      }

      if (!messageMatches || !addressMatches) {
        return {
          success: false,
          message: 'Message or address mismatch',
        };
      }

      if (!isRegistered) {
        return {
          success: false,
          message: 'Wallet not registered',
        };
      }

      const user = this.registeredUsers.find(user => user.address === signerStakeAddrBech32);

      return {
        user,
        success: true,
        message: '✅ Authentication success!',
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
