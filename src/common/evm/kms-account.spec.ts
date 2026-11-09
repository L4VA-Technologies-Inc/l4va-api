import { generateKeyPairSync } from 'crypto';

import { describe, expect, it } from '@jest/globals';
import {
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

import { addressFromSpkiPem, createKmsAccount, parseDerSignature, type KmsSigningClient } from './kms-account';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** DER-encodes (r, s) the way KMS returns it. */
function der(r: bigint, s: bigint): Buffer {
  const int = (n: bigint): Buffer => {
    let bytes = Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
    while (bytes.length > 1 && bytes[0] === 0 && bytes[1] < 0x80) bytes = bytes.subarray(1);
    if (bytes[0] >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** A software key behind the KMS client interface. `highS` returns the other valid s, as KMS may. */
function fakeKms(highS: boolean): { client: KmsSigningClient; address: Address } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const d = privateKey.export({ format: 'jwk' }).d as string;
  const key = `0x${Buffer.from(d, 'base64url').toString('hex').padStart(64, '0')}` as Hex;
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

  const client: KmsSigningClient = {
    getPublicKey: async () => [{ pem, algorithm: 'EC_SIGN_SECP256K1_SHA256' }],
    asymmetricSign: async ({ digest }) => {
      const sig = await sign({ hash: `0x${digest.sha256.toString('hex')}`, privateKey: key });
      const s = BigInt(sig.s);
      return [{ signature: der(BigInt(sig.r), highS ? N - s : s) }];
    },
  };
  return { client, address: privateKeyToAccount(key).address };
}

describe('KMS account', () => {
  it('derives the address from the KMS public key', async () => {
    const { client, address } = fakeKms(false);
    const [{ pem }] = await client.getPublicKey({ name: 'k' });
    expect(addressFromSpkiPem(pem as string)).toBe(address);
  });

  it('parses DER integers with a sign-padding byte', () => {
    expect(parseDerSignature(der(N - 1n, 5n))).toEqual({ r: N - 1n, s: 5n });
  });

  for (const highS of [false, true]) {
    describe(highS ? 'when KMS returns a high s' : 'when KMS returns a low s', () => {
      it('signs typed data that recovers to the key', async () => {
        const { client, address } = fakeKms(highS);
        const account = await createKmsAccount(client, 'k', address);
        const typedData = {
          domain: { name: 'L4VA-VaultFactory', version: '1', chainId: 4663, verifyingContract: address },
          types: { Ping: [{ name: 'n', type: 'uint256' }] },
          primaryType: 'Ping',
          message: { n: 7n },
        } as const;
        const signature = await account.signTypedData(typedData);
        // Ethereum rejects high-s signatures; the account must always emit the low form.
        expect(BigInt(`0x${signature.slice(66, 130)}`) <= N / 2n).toBe(true);
        expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(address);
      });

      it('signs messages and transactions that recover to the key', async () => {
        const { client, address } = fakeKms(highS);
        const account = await createKmsAccount(client, 'k');

        const signature = await account.signMessage({ message: 'hello' });
        expect(await recoverMessageAddress({ message: 'hello', signature })).toBe(address);

        const signed = await account.signTransaction({
          type: 'eip1559',
          chainId: 4663,
          nonce: 3,
          to: address,
          value: 1n,
          gas: 21000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        });
        expect(parseTransaction(signed).chainId).toBe(4663);
        expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(address);
      });
    });
  }

  it('refuses a key whose address is not the configured one', async () => {
    const { client } = fakeKms(false);
    await expect(createKmsAccount(client, 'k', `0x${'1'.repeat(40)}`)).rejects.toThrow('configured address');
  });

  it('refuses a key that is not secp256k1', async () => {
    const client: KmsSigningClient = {
      getPublicKey: async () => [{ pem: 'x', algorithm: 'EC_SIGN_P256_SHA256' }],
      asymmetricSign: async () => [{}],
    };
    await expect(createKmsAccount(client, 'k')).rejects.toThrow('expected EC_SIGN_SECP256K1_SHA256');
  });
});
