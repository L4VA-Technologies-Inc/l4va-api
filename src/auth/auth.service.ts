import { Injectable } from '@nestjs/common';
import { Buffer } from 'buffer';
import { COSESign1, COSEKey, Label, Int, BigNum } from '@emurgo/cardano-message-signing-nodejs';
import { Ed25519Signature, PublicKey, Address } from '@emurgo/cardano-serialization-lib-nodejs';

@Injectable()
export class AuthService {
  // Sample list of registered users (move to database in production)
  private registeredUsers = [
    'stake1uxslhvvuu4utn7gcqv3rw66rfuj4vh9tlhl42cc96gjkw4gmym2rt',
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

      // Get the signing address from headers
      const headermap = decoded.headers().protected().deserialized_headers();
      const addressHex = Buffer.from(headermap.header(Label.new_text('address')).to_bytes())
        .toString('hex')
        .substring(4);
      const address = Address.from_bytes(Buffer.from(addressHex, 'hex'));

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
      const isRegistered = this.registeredUsers.includes(stakeAddress);

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

      if (!isRegistered) {
        return {
          success: false,
          message: 'Wallet not registered',
        };
      }

      return {
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
