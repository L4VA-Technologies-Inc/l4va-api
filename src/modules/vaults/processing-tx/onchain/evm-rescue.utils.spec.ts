import { describe, expect, it } from '@jest/globals';
import { type Address, type Hex, encodeAbiParameters, pad, toEventSelector } from 'viem';

import { findInboundTransfers, isMint, RescueKind, rescueSourceId, transactionTouchedVault } from './evm-rescue.utils';

const TX: Hex = `0x${'11'.repeat(32)}`;
const VAULT: Address = '0x00000000000000000000000000000000000000Aa';
const SENDER: Address = '0x00000000000000000000000000000000000000Bb';
const OTHER: Address = '0x00000000000000000000000000000000000000Cc';
const TOKEN: Address = '0x00000000000000000000000000000000000000Dd';
const ZERO: Address = '0x0000000000000000000000000000000000000000';

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const SINGLE = toEventSelector('TransferSingle(address,address,address,uint256,uint256)');
const BATCH = toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])');
const t = (a: Address): Hex => pad(a, { size: 32 });
const u = (v: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [v]);

describe('rescueSourceId', () => {
  // Reference values: `cast keccak $(cast abi-encode 'f(bytes32,uint256[,uint256])' ...)`,
  // i.e. keccak256(abi.encode(...)) exactly as the Solidity tests build it.
  it('matches abi.encode(txHash, logIndex) for ERC-20', () => {
    expect(rescueSourceId(TX, 3)).toBe('0x3b31255a9f930bb80359c3ba2fef22133cd773f2653bd87c6035861658aa0882');
  });

  it('matches abi.encode(txHash, logIndex, tokenId) for NFTs', () => {
    expect(rescueSourceId(TX, 3, 42n)).toBe('0x36644acb86573103a2b7fcb81d5bc07447503ee614e333ddac42e992140b2008');
  });

  it('differs per log and per token id, so two transfers in one tx never share an id', () => {
    expect(rescueSourceId(TX, 0, 10n)).not.toBe(rescueSourceId(TX, 1, 11n));
    expect(rescueSourceId(TX, 0, 10n)).not.toBe(rescueSourceId(TX, 0, 11n));
    expect(rescueSourceId(TX, 0)).not.toBe(rescueSourceId(TX, 0, 0n));
  });
});

describe('findInboundTransfers', () => {
  it('reads ERC-20, ERC-721, ERC-1155 single and batch transfers into the vault', () => {
    const logs = [
      { address: TOKEN, topics: [TRANSFER, t(SENDER), t(VAULT)], data: u(5n), logIndex: 0 },
      { address: TOKEN, topics: [TRANSFER, t(SENDER), t(VAULT), u(7n)], data: '0x' as Hex, logIndex: 1 },
      {
        address: TOKEN,
        topics: [SINGLE, t(SENDER), t(SENDER), t(VAULT)],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [9n, 3n]),
        logIndex: 2,
      },
      {
        address: TOKEN,
        topics: [BATCH, t(SENDER), t(SENDER), t(VAULT)],
        data: encodeAbiParameters(
          [{ type: 'uint256[]' }, { type: 'uint256[]' }],
          [
            [1n, 2n],
            [4n, 6n],
          ]
        ),
        logIndex: 3,
      },
    ];
    const out = findInboundTransfers(TX, logs, VAULT);
    expect(out.map(o => [o.kind, o.tokenId, o.amount, o.logIndex])).toEqual([
      [RescueKind.ERC20, 0n, 5n, 0],
      [RescueKind.ERC721, 7n, 1n, 1],
      [RescueKind.ERC1155, 9n, 3n, 2],
      [RescueKind.ERC1155, 1n, 4n, 3],
      [RescueKind.ERC1155, 2n, 6n, 3],
    ]);
    expect(out.every(o => o.from.toLowerCase() === SENDER.toLowerCase())).toBe(true);
    expect(new Set(out.map(o => o.sourceId)).size).toBe(out.length);
    expect(out[0].sourceId).toBe(rescueSourceId(TX, 0));
    expect(out[1].sourceId).toBe(rescueSourceId(TX, 1, 7n));
  });

  it('ignores transfers to other addresses and malformed logs', () => {
    const logs = [
      { address: TOKEN, topics: [TRANSFER, t(SENDER), t(OTHER)], data: u(5n), logIndex: 0 },
      { address: TOKEN, topics: [TRANSFER, t(VAULT), t(SENDER)], data: u(5n), logIndex: 1 },
      { address: TOKEN, topics: [TRANSFER, t(SENDER), t(VAULT)], data: '0x' as Hex, logIndex: 2 },
      { address: TOKEN, topics: [TRANSFER, t(SENDER), t(VAULT)], data: u(5n), logIndex: null },
    ];
    expect(findInboundTransfers(TX, logs, VAULT)).toEqual([]);
  });

  it('flags mints, which have no sender to return to', () => {
    const [m] = findInboundTransfers(
      TX,
      [{ address: TOKEN, topics: [TRANSFER, t(ZERO), t(VAULT)], data: u(5n), logIndex: 0 }],
      VAULT
    );
    expect(isMint(m)).toBe(true);
  });
});

describe('transactionTouchedVault', () => {
  const stray = [{ address: TOKEN, topics: [TRANSFER, t(SENDER), t(VAULT)], data: u(5n), logIndex: 0 }];

  it('is false for a plain token transfer to the vault', () => {
    expect(transactionTouchedVault(TOKEN, stray, VAULT)).toBe(false);
  });

  it('is true when the transaction called the vault (contribution, swap, refund)', () => {
    expect(transactionTouchedVault(VAULT, stray, VAULT)).toBe(true);
  });

  it('is true when the vault emitted an event, e.g. a call routed through a multisig or router', () => {
    const viaSafe = [...stray, { address: VAULT, topics: [TRANSFER], data: '0x' as Hex, logIndex: 1 }];
    expect(transactionTouchedVault(OTHER, viaSafe, VAULT)).toBe(true);
  });
});
