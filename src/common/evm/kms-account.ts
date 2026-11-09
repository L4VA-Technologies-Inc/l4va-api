import {
  hashMessage,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { publicKeyToAddress, toAccount } from 'viem/accounts';

/**
 * A viem account whose key lives in Google Cloud KMS (EC_SIGN_SECP256K1_SHA256).
 * The private key never leaves KMS: we hash locally and ask KMS to sign the
 * 32-byte digest, then turn its DER signature into an Ethereum one.
 */

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KMS_ALGORITHM = 'EC_SIGN_SECP256K1_SHA256';

/** The two calls we need from `KeyManagementServiceClient`; narrowed so tests can fake it. */
export interface KmsSigningClient {
  getPublicKey(request: { name: string }): Promise<[{ pem?: string | null; algorithm?: unknown }, ...unknown[]]>;
  asymmetricSign(request: {
    name: string;
    digest: { sha256: Buffer };
  }): Promise<[{ signature?: Uint8Array | string | null }, ...unknown[]]>;
}

/** Ethereum address of a secp256k1 key from its SubjectPublicKeyInfo PEM. */
export function addressFromSpkiPem(pem: string): Address {
  const der = Buffer.from(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''), 'base64');
  // The SPKI ends with the BIT STRING holding the 65-byte uncompressed point (0x04 || X || Y).
  const point = der.subarray(der.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('KMS public key is not an uncompressed secp256k1 point');
  }
  return publicKeyToAddress(`0x${point.toString('hex')}`);
}

/** Reads `(r, s)` from a DER `SEQUENCE { INTEGER r, INTEGER s }`. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let offset = 0;
  const readLength = (): number => {
    const first = der[offset++];
    if (first < 0x80) return first;
    const bytes = first & 0x7f;
    let length = 0;
    for (let i = 0; i < bytes; i++) length = (length << 8) | der[offset++];
    return length;
  };
  const readInteger = (): bigint => {
    if (der[offset++] !== 0x02) throw new Error('Malformed DER signature: expected INTEGER');
    const length = readLength();
    const value = der.subarray(offset, offset + length);
    offset += length;
    return BigInt(`0x${Buffer.from(value).toString('hex') || '0'}`);
  };

  if (der[offset++] !== 0x30) throw new Error('Malformed DER signature: expected SEQUENCE');
  readLength();
  const r = readInteger();
  const s = readInteger();
  return { r, s };
}

/**
 * Builds the Ethereum signature for `hash`. Ethereum only accepts the low-s form,
 * and KMS does not return the recovery bit, so it is found by trying both.
 */
export async function toEthereumSignature(hash: Hex, der: Uint8Array, address: Address): Promise<Hex> {
  const { r, s: rawS } = parseDerSignature(der);
  const s = rawS > SECP256K1_N / 2n ? SECP256K1_N - rawS : rawS;
  const hex = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

  for (const yParity of [0, 1]) {
    const signature = serializeSignature({ r: hex(r), s: hex(s), yParity });
    const recovered = await recoverAddress({ hash, signature });
    if (recovered.toLowerCase() === address.toLowerCase()) return signature;
  }
  throw new Error(`KMS signature does not recover to ${address}`);
}

/**
 * Creates the account. Fails when the key is not secp256k1 or, if
 * `expectedAddress` is given, when the key's address differs from it — so a
 * wrong key version in config can never sign as the configured role.
 */
export async function createKmsAccount(
  client: KmsSigningClient,
  keyVersionName: string,
  expectedAddress?: Address
): Promise<LocalAccount> {
  const [publicKey] = await client.getPublicKey({ name: keyVersionName });
  if (publicKey.algorithm !== KMS_ALGORITHM) {
    throw new Error(`KMS key ${keyVersionName} is ${String(publicKey.algorithm)}, expected ${KMS_ALGORITHM}`);
  }
  if (!publicKey.pem) throw new Error(`KMS key ${keyVersionName} returned no public key`);

  const address = addressFromSpkiPem(publicKey.pem);
  if (expectedAddress && expectedAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`KMS key ${keyVersionName} is ${address}, but the configured address is ${expectedAddress}`);
  }

  const signHash = async (hash: Hex): Promise<Hex> => {
    // KMS signs the supplied 32 bytes as-is; the `sha256` field only names the digest length.
    const [response] = await client.asymmetricSign({
      name: keyVersionName,
      digest: { sha256: Buffer.from(hash.slice(2), 'hex') },
    });
    if (!response.signature) throw new Error(`KMS returned no signature for ${keyVersionName}`);
    const der = typeof response.signature === 'string' ? Buffer.from(response.signature, 'base64') : response.signature;
    return toEthereumSignature(hash, der, address);
  };

  return toAccount({
    address,
    sign: ({ hash }) => signHash(hash),
    signMessage: ({ message }) => signHash(hashMessage(message)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: typedData => signHash(hashTypedData(typedData as any)),
    async signTransaction(transaction, { serializer = serializeTransaction } = {}) {
      // Same as viem's local signer: blob sidecars are not part of the signed payload.
      const signable = transaction.type === 'eip4844' ? { ...transaction, sidecars: false } : transaction;
      const signature = await signHash(keccak256(await serializer(signable)));
      return serializer(transaction, parseSignature(signature));
    },
  });
}
