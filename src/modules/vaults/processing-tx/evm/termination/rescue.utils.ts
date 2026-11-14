import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  isAddressEqual,
  keccak256,
  toEventSelector,
  zeroAddress,
} from 'viem';

/** Mirrors the kind constants in `Vault.untrackedBalance` (RESCUE_NATIVE … RESCUE_ERC1155). */
export enum RescueKind {
  Native = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const TRANSFER_SINGLE = toEventSelector('TransferSingle(address,address,address,uint256,uint256)');
const TRANSFER_BATCH = toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])');

export interface ReceiptLogLike {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number | bigint | null;
}

/** One transfer into the vault found in a transaction receipt. */
export interface InboundTransfer {
  logIndex: number;
  kind: RescueKind;
  asset: Address;
  from: Address;
  tokenId: bigint;
  amount: bigint;
  sourceId: Hex;
}

/**
 * One id per inbound transfer, as the contract expects: ERC-20 → keccak256(abi.encode(txHash, logIndex));
 * NFTs → keccak256(abi.encode(txHash, logIndex, tokenId)), so every id of a TransferBatch is distinct.
 * Must match `test/Vault.rescue.attacks.t.sol#_src` in vault-contract-solidity.
 */
export function rescueSourceId(txHash: Hex, logIndex: number, tokenId?: bigint): Hex {
  if (tokenId === undefined) {
    return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [txHash, BigInt(logIndex)]));
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
      [txHash, BigInt(logIndex), tokenId]
    )
  );
}

const topicAddress = (t: Hex): Address => `0x${t.slice(26)}` as Address;

/**
 * ERC-20 / ERC-721 `Transfer` and ERC-1155 `TransferSingle` / `TransferBatch` logs whose recipient is
 * `vault`. ERC-20 and ERC-721 share the `Transfer` signature and are told apart by the topic count
 * (tokenId is indexed for ERC-721). Unknown or malformed logs are skipped.
 */
export function findInboundTransfers(txHash: Hex, logs: readonly ReceiptLogLike[], vault: Address): InboundTransfer[] {
  const out: InboundTransfer[] = [];
  for (const log of logs) {
    if (log.logIndex === null || log.logIndex === undefined) continue;
    const logIndex = Number(log.logIndex);
    const [sig] = log.topics;
    try {
      if (sig === TRANSFER && log.topics.length === 3) {
        if (!isAddressEqual(topicAddress(log.topics[2]), vault)) continue;
        const [amount] = decodeAbiParameters([{ type: 'uint256' }], log.data);
        out.push({
          logIndex,
          kind: RescueKind.ERC20,
          asset: log.address,
          from: topicAddress(log.topics[1]),
          tokenId: 0n,
          amount,
          sourceId: rescueSourceId(txHash, logIndex),
        });
      } else if (sig === TRANSFER && log.topics.length === 4) {
        if (!isAddressEqual(topicAddress(log.topics[2]), vault)) continue;
        const tokenId = BigInt(log.topics[3]);
        out.push({
          logIndex,
          kind: RescueKind.ERC721,
          asset: log.address,
          from: topicAddress(log.topics[1]),
          tokenId,
          amount: 1n,
          sourceId: rescueSourceId(txHash, logIndex, tokenId),
        });
      } else if (sig === TRANSFER_SINGLE && log.topics.length === 4) {
        if (!isAddressEqual(topicAddress(log.topics[3]), vault)) continue;
        const [tokenId, amount] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], log.data);
        out.push({
          logIndex,
          kind: RescueKind.ERC1155,
          asset: log.address,
          from: topicAddress(log.topics[2]),
          tokenId,
          amount,
          sourceId: rescueSourceId(txHash, logIndex, tokenId),
        });
      } else if (sig === TRANSFER_BATCH && log.topics.length === 4) {
        if (!isAddressEqual(topicAddress(log.topics[3]), vault)) continue;
        const [ids, values] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data);
        if (ids.length !== values.length) continue;
        ids.forEach((tokenId, i) =>
          out.push({
            logIndex,
            kind: RescueKind.ERC1155,
            asset: log.address,
            from: topicAddress(log.topics[2]),
            tokenId,
            amount: values[i],
            sourceId: rescueSourceId(txHash, logIndex, tokenId),
          })
        );
      }
    } catch {
      // Not a standard transfer log (or a non-standard token): not rescuable through this path.
    }
  }
  return out;
}

/**
 * A transfer is a plain "sent straight to the vault" stray only if the transaction did not go
 * through the vault. Contributions, swaps, position closes and refunds all call the vault and make
 * it emit events; their inbound transfers are ledger money and must never be treated as strays,
 * even when the vault happens to hold other strays of the same token.
 */
export function transactionTouchedVault(
  txTo: Address | null | undefined,
  logs: readonly ReceiptLogLike[],
  vault: Address
): boolean {
  if (txTo && isAddressEqual(txTo, vault)) return true;
  return logs.some(l => isAddressEqual(l.address, vault));
}

export function isMint(t: InboundTransfer): boolean {
  return isAddressEqual(t.from, zeroAddress);
}
