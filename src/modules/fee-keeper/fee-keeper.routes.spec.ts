import { describe, expect, it } from '@jest/globals';
import { decodeAbiParameters, type Address } from 'viem';

import { assertRouteMatches, encodeRoute, encodeV3Path } from './fee-keeper.routes';

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

describe('fee-keeper routes', () => {
  it('encodes a v3 path as packed token/fee/token', () => {
    const packed = encodeV3Path([WETH, 100, USDG]);
    expect(packed).toBe(`0x${WETH.slice(2)}000064${USDG.slice(2)}`);
  });

  it('rejects malformed v3 paths', () => {
    expect(() => encodeV3Path([WETH, 100])).toThrow();
    expect(() => encodeV3Path([WETH, 2500, USDG])).toThrow(/fee/);
    expect(() => encodeV3Path([WETH, 100, 'not-an-address' as Address])).toThrow();
    expect(() => encodeV3Path([WETH, 100, USDG, 100, WETH, 100, USDG, 100, WETH])).toThrow(/hops/);
  });

  it('encodes v3 routes as abi.encode(uint8 0, bytes path)', () => {
    const encoded = encodeRoute({ kind: 'v3', path: [WETH, 500, USDG] });
    const [kind, path] = decodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], encoded);
    expect(kind).toBe(0);
    expect(path).toBe(encodeV3Path([WETH, 500, USDG]));
  });

  it('encodes v4 routes as abi.encode(uint8 1, abi.encode(PoolKey, zeroForOne))', () => {
    const encoded = encodeRoute({
      kind: 'v4',
      currency0: WETH,
      currency1: USDG,
      fee: 500,
      tickSpacing: 10,
      zeroForOne: false,
    });
    const [kind, inner] = decodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], encoded);
    expect(kind).toBe(1);
    const [key, zeroForOne] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
        { type: 'bool' },
      ],
      inner
    );
    expect((key as any).currency0.toLowerCase()).toBe(WETH);
    expect((key as any).fee).toBe(500);
    expect((key as any).tickSpacing).toBe(10);
    expect((key as any).hooks).toBe(ZERO);
    expect(zeroForOne).toBe(false);
  });

  it('rejects hooked or unsorted v4 keys', () => {
    expect(() =>
      encodeRoute({
        kind: 'v4',
        currency0: WETH,
        currency1: USDG,
        fee: 500,
        tickSpacing: 10,
        hooks: USDG,
        zeroForOne: true,
      })
    ).toThrow(/hook/);
    expect(() =>
      encodeRoute({ kind: 'v4', currency0: USDG, currency1: WETH, fee: 500, tickSpacing: 10, zeroForOne: true })
    ).toThrow(/sort/);
  });

  it('assertRouteMatches mirrors the adapter asset checks', () => {
    // Native ETH -> USDG over v3 must start at WETH.
    expect(() => assertRouteMatches({ kind: 'v3', path: [WETH, 100, USDG] }, ZERO, USDG, WETH)).not.toThrow();
    expect(() => assertRouteMatches({ kind: 'v3', path: [USDG, 100, WETH] }, ZERO, USDG, WETH)).toThrow();
    // Native ETH -> USDG over v4 uses address(0), not WETH.
    const v4 = { kind: 'v4' as const, currency0: ZERO, currency1: USDG, fee: 100, tickSpacing: 1, zeroForOne: true };
    expect(() => assertRouteMatches(v4, ZERO, USDG, WETH)).not.toThrow();
    expect(() => assertRouteMatches({ ...v4, zeroForOne: false }, ZERO, USDG, WETH)).toThrow();
  });
});
