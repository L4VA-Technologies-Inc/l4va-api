import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';

import { EvmTerminationService } from './evm-termination.service';
import { EvmVaultOnchainStatus } from './vault.abi';

import { ChainType } from '@/types/vault.types';

const VAULT = '0x67b9869580f32e75e985a20db36c90f4b35d207b';
const RECEIPT = '0x078d10051959e63522e1f973d1c29d6bed195716';

/** Rows of a custody plan: native + `n - 1` tokens. */
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    asset: (i === 0
      ? '0x0000000000000000000000000000000000000000'
      : `0x${i.toString(16).padStart(40, '0')}`) as `0x${string}`,
    rate: 1n,
    implied: 1n,
    free: 1n,
    distributionBps: 10_000n,
  }));

function makeService(opts: { cap: number; planRows: ReturnType<typeof rows>; receipts?: string[] }) {
  const reads: Record<string, unknown> = {
    status: EvmVaultOnchainStatus.Locked,
    activeExternalPositionCount: 0n,
    MAX_TERMINATION_ASSETS: BigInt(opts.cap),
  };
  const contractReader = {
    publicClient: { readContract: jest.fn(async ({ functionName }: { functionName: string }) => reads[functionName]) },
  };
  const preflight = { check: jest.fn(async () => ({ ok: true, blockers: [] })) };
  const lpExit = { exitIntoVault: jest.fn(async () => ({ withdrawnTokenIds: [] })) };
  const vaultsRepository = {
    findOne: jest.fn(async () => ({ id: 'v1', chain_type: ChainType.robinhood, contract_address: VAULT })),
  };
  const svc = new EvmTerminationService(
    vaultsRepository as never,
    {} as never,
    {} as never,
    contractReader as never,
    {} as never,
    preflight as never,
    lpExit as never,
    {} as never
  );
  jest.spyOn(svc, 'buildCustodyPlan').mockResolvedValue({ totalSupply: 1n, rows: opts.planRows, undistributable: [] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(svc as any, 'withdrawnV4Receipts').mockResolvedValue(opts.receipts ?? []);
  const send = jest
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(svc as any, '_sendSimple')
    .mockResolvedValue({ txHash: '0xabc' } as never);
  return { svc, send, preflight };
}

describe('beginTerminationPreparing: asset cap is checked before the one-way door', () => {
  it('refuses a vault over its cap while still Locked, naming how many to sell', async () => {
    const { svc, send } = makeService({ cap: 16, planRows: rows(18) });
    await expect(svc.beginTerminationPreparing('v1')).rejects.toThrow(BadRequestException);
    await expect(svc.beginTerminationPreparing('v1')).rejects.toThrow(
      /18 distributable assets.*cap of 16.*Sell at least 2/
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('proceeds at exactly the cap', async () => {
    const { svc, send } = makeService({ cap: 16, planRows: rows(16) });
    await expect(svc.beginTerminationPreparing('v1')).resolves.toEqual({ txHash: '0xabc' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not count a withdrawn LP receipt (it is waived automatically)', async () => {
    const plan = rows(17);
    plan[16].asset = RECEIPT as `0x${string}`;
    const { svc, send } = makeService({ cap: 16, planRows: plan, receipts: [RECEIPT] });
    await expect(svc.beginTerminationPreparing('v1')).resolves.toEqual({ txHash: '0xabc' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses the vault’s own cap: 40 assets pass on a 56-cap vault', async () => {
    const { svc, send } = makeService({ cap: 56, planRows: rows(40) });
    await expect(svc.beginTerminationPreparing('v1')).resolves.toEqual({ txHash: '0xabc' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
