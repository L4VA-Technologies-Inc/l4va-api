import { Injectable } from '@nestjs/common';
import { Buffer } from 'buffer';
import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import { Ed25519Signature, PublicKey } from '@emurgo/cardano-serialization-lib-nodejs';

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
    message: string;
    stakeAddress: string;
  }) {
    try {
      const { signature, message, stakeAddress } = signatureData;

      // Decode the signature
      const decoded = COSESign1.from_bytes(Buffer.from(signature.signature, 'hex'));

      // Get the public key
      const key = COSEKey.from_bytes(Buffer.from(signature.key, 'hex'));
      const pubKeyBytes = key.header(Label.new_int(Int.new_negative(BigNum.from_str('2')))).as_bytes();
      const publicKey = PublicKey.from_bytes(pubKeyBytes);

      // Get payload and signature
      const payload = decoded.payload();
      const sig = Ed25519Signature.from_bytes(decoded.signature());
      const signedData = decoded.signed_data().to_bytes();

      // Verify the signature
      const isVerified = publicKey.verify(signedData, sig);

      // Verify payload matches expected message
      const receivedMessage = Buffer.from(payload).toString('utf8');
      const payloadMatches = receivedMessage === message;

      // Check if user is registered
      const user = this.registeredUsers.find(user => user.address === stakeAddress);

      if (!isVerified) {
        return {
          success: false,
          message: 'Invalid signature',
        };
      }

      if (!payloadMatches) {
        return {
          success: false,
          message: 'Message mismatch',
        };
      }

      if (!user) {
        return {
          success: false,
          message: 'Wallet not registered',
        };
      }

      return {
        user,
        success: true,
        message: '✅ Signature verified successfully!',
      };

    } catch (error) {
      console.error('Verification error:', error);
      return {
        success: false,
        message: error.message || 'Verification failed',
      };
    }
  }
}
