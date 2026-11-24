import { describe, expect, it, jest } from '@jest/globals';

import { IndexVaultService } from './index-vault.service';

import { Proposal } from '@/database/proposal.entity';
import { Vault } from '@/database/vault.entity';

/**
 * Daily sell cap handling of the guarded swap adapter:
 * - `clipSellsToCap` trims a sell to what the adapter allows right now (execution);
 * - `reweightCapWait` holds a passed re-weight until the cap window can cover it.
 * The service is built without Nest so only the collaborators these paths use are mocked.
 */

const VAULT = { id: 'vault-1', contract_address: '0x00000000000000000000000000000000000000aa' } as unknown as Vault;
const L4VA = '0x0c020bef365d7001611ef1cecd6084cdd6b73683';
const NVDA = '0x00000000000000000000000000000000000000b2';
const NATIVE = '0x0000000000000000000000000000000000000000';

type SellCap = { guarded: boolean; capBps: number | null; remaining: string | null };

function makeService(caps: Record<string, SellCap>) {
  const svc = Object.create(IndexVaultService.prototype) as IndexVaultService;
  const sellCap = jest.fn(async (_vault: unknown, asset: string) => {
    const cap = caps[asset.toLowerCase()];
    if (!cap) throw new Error(`no cap mocked for ${asset}`);
    return cap;
  });
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  Object.assign(svc, { routeService: { sellCap }, logger });
  return { svc, sellCap, logger };
}

const guarded = (remaining: bigint, capBps = 2500): SellCap => ({
  guarded: true,
  capBps,
  remaining: remaining.toString(),
});

type Sell = { assetIn: string; assetOut: string; amountIn: bigint };
const sell = (assetIn: string, amountIn: bigint): Sell => ({ assetIn, assetOut: NATIVE, amountIn });

function clip(svc: IndexVaultService, sells: Sell[], vault: Vault = VAULT): Promise<Sell[]> {
  return (svc as unknown as { clipSellsToCap: (v: Vault, id: string, s: Sell[]) => Promise<Sell[]> }).clipSellsToCap(
    vault,
    'run-1',
    sells
  );
}

describe('IndexVaultService.clipSellsToCap', () => {
  it('keeps a sell that fits the remaining cap', async () => {
    const { svc, logger } = makeService({ [L4VA]: guarded(1_000n) });
    await expect(clip(svc, [sell(L4VA, 1_000n)])).resolves.toEqual([sell(L4VA, 1_000n)]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('trims a sell larger than the remaining cap to the remaining amount', async () => {
    const { svc, logger } = makeService({ [L4VA]: guarded(250n) });
    await expect(clip(svc, [sell(L4VA, 270n)])).resolves.toEqual([sell(L4VA, 250n)]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('drops a sell when nothing is left in the window', async () => {
    const { svc } = makeService({ [L4VA]: guarded(0n) });
    await expect(clip(svc, [sell(L4VA, 100n)])).resolves.toEqual([]);
  });

  it('leaves sells alone on an unguarded adapter', async () => {
    const { svc } = makeService({ [L4VA]: { guarded: false, capBps: null, remaining: null } });
    await expect(clip(svc, [sell(L4VA, 10n ** 30n)])).resolves.toEqual([sell(L4VA, 10n ** 30n)]);
  });

  it('checks each asset against its own cap', async () => {
    const { svc } = makeService({ [L4VA]: guarded(50n), [NVDA]: guarded(500n) });
    await expect(clip(svc, [sell(L4VA, 80n), sell(NVDA, 400n)])).resolves.toEqual([sell(L4VA, 50n), sell(NVDA, 400n)]);
  });

  it('does not read caps for a vault without a contract', async () => {
    const { svc, sellCap } = makeService({});
    const vault = { id: 'v', contract_address: null } as unknown as Vault;
    await expect(clip(svc, [sell(L4VA, 5n)], vault)).resolves.toEqual([sell(L4VA, 5n)]);
    expect(sellCap).not.toHaveBeenCalled();
  });
});

describe('IndexVaultService.reweightCapWait', () => {
  const proposal = (extra: Record<string, unknown> = {}): Proposal =>
    ({
      id: 'p-1',
      vaultId: VAULT.id,
      metadata: {
        indexReweight: {
          targets: [
            { assetAddress: L4VA, weightBps: 5000, symbol: 'L4VA' },
            { assetAddress: NVDA, weightBps: 5000, symbol: 'NVDA' },
          ],
          reserveBps: 0,
          ...extra,
        },
      },
    }) as unknown as Proposal;

  type Preview = {
    sells: { asset: string; amountIn: string }[];
    overCap: { asset: string; maxAmountIn: string }[];
  };

  function withPreview(caps: Record<string, SellCap>, preview: Preview | Error) {
    const ctx = makeService(caps);
    Object.assign(ctx.svc, {
      requireIndexVault: jest.fn(async () => VAULT),
      previewReweight: jest.fn(async () => {
        if (preview instanceof Error) throw preview;
        return { buys: [], skipped: [], minTradeNative: '0', navNative: '0', ...preview };
      }),
    });
    return ctx;
  }

  it('runs at once when every sell fits the remaining cap', async () => {
    const { svc } = withPreview({ [L4VA]: guarded(300n) }, { sells: [{ asset: L4VA, amountIn: '240' }], overCap: [] });
    await expect(svc.reweightCapWait(proposal())).resolves.toBeNull();
  });

  it('waits when a sell fits the full cap but not what is left of the window', async () => {
    const { svc } = withPreview({ [L4VA]: guarded(100n) }, { sells: [{ asset: L4VA, amountIn: '240' }], overCap: [] });
    await expect(svc.reweightCapWait(proposal())).resolves.toMatch(/daily sell cap for L4VA/);
  });

  it('waits for a full window when the sell grew past the cap, then runs (trimmed)', async () => {
    const preview = { sells: [{ asset: L4VA, amountIn: '270' }], overCap: [{ asset: L4VA, maxAmountIn: '250' }] };
    const partial = withPreview({ [L4VA]: guarded(200n) }, preview);
    await expect(partial.svc.reweightCapWait(proposal())).resolves.toMatch(/L4VA/);

    const full = withPreview({ [L4VA]: guarded(250n) }, preview);
    await expect(full.svc.reweightCapWait(proposal())).resolves.toBeNull();
  });

  it('ignores unguarded adapters', async () => {
    const { svc } = withPreview(
      { [L4VA]: { guarded: false, capBps: null, remaining: null } },
      { sells: [{ asset: L4VA, amountIn: '999999' }], overCap: [] }
    );
    await expect(svc.reweightCapWait(proposal())).resolves.toBeNull();
  });

  it('does not wait on a schedule-only proposal', async () => {
    const { svc, sellCap } = withPreview({}, { sells: [], overCap: [] });
    await expect(svc.reweightCapWait(proposal({ scheduleOnly: true }))).resolves.toBeNull();
    expect(sellCap).not.toHaveBeenCalled();
  });

  it('does not block execution when the check itself fails', async () => {
    const { svc, logger } = withPreview({}, new Error('rpc down'));
    await expect(svc.reweightCapWait(proposal())).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
