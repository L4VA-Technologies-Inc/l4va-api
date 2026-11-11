import { describe, expect, it, jest } from '@jest/globals';
import type { Address } from 'viem';

import { EvmCycleCloseService } from './evm-cycle-close.service';

import { ChainType } from '@/types/vault.types';

const VAULT: Address = '0x00000000000000000000000000000000000000Aa';
const ADMIN: Address = '0x00000000000000000000000000000000000000Bb';

type Fn = (...args: any[]) => Promise<unknown>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function build(opts: { simulate: Fn; send?: Fn }) {
  const simulateContract = jest.fn<Fn>(opts.simulate);
  const sendAndConfirm = jest.fn<Fn>(opts.send ?? (async () => ({ hash: '0xabc', receipt: {}, decodedEvents: [] })));
  const sendAlert = jest.fn<Fn>(async () => undefined);
  const vaultsRepository = {
    findOne: jest.fn<Fn>(async () => ({ id: 'v1', contract_address: VAULT, chain_type: ChainType.robinhood })),
  };
  const service = new EvmCycleCloseService(
    vaultsRepository as any,
    {} as any,
    {} as any,
    {} as any,
    { publicClient: { simulateContract } } as any,
    { address: ADMIN, sendAndConfirm } as any,
    { sendAlert } as any
  );
  return { service, simulateContract, sendAndConfirm, sendAlert };
}

describe('EvmCycleCloseService — closeAcquireWindow', () => {
  it('probes from the admin address and caches a vault that has the function', async () => {
    const { service, simulateContract } = build({ simulate: async () => ({}) });
    expect(await service.supportsCloseAcquireWindow(VAULT)).toBe(true);
    expect(await service.supportsCloseAcquireWindow(VAULT)).toBe(true);
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect((simulateContract.mock.calls[0][0] as any).account).toBe(ADMIN);
    expect((simulateContract.mock.calls[0][0] as any).functionName).toBe('closeAcquireWindow');
  });

  it('treats any revert (older vault without the function) as unsupported, without caching it', async () => {
    const { service, simulateContract } = build({
      simulate: async () => {
        throw new Error('execution reverted');
      },
    });
    expect(await service.supportsCloseAcquireWindow(VAULT)).toBe(false);
    expect(await service.supportsCloseAcquireWindow(VAULT)).toBe(false);
    expect(simulateContract).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an older vault', async () => {
    const { service, sendAndConfirm } = build({
      simulate: async () => {
        throw new Error('execution reverted');
      },
    });
    expect(await service.closeAcquireWindowIfSupported('v1')).toBe(false);
    expect(sendAndConfirm).not.toHaveBeenCalled();
  });

  it('closes the window on a supported vault and expects AcquireWindowClosed', async () => {
    const { service, sendAndConfirm } = build({ simulate: async () => ({}) });
    expect(await service.closeAcquireWindowIfSupported('v1')).toBe(true);
    expect(sendAndConfirm).toHaveBeenCalledTimes(1);
    const [call, events] = sendAndConfirm.mock.calls[0] as any[];
    expect(call.functionName).toBe('closeAcquireWindow');
    expect(call.address).toBe(VAULT);
    expect(events).toEqual(['AcquireWindowClosed']);
  });

  it('reports a failed close and returns false, so the snapshot keeps waiting', async () => {
    const { service, sendAlert } = build({
      simulate: async () => ({}),
      send: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await service.closeAcquireWindowIfSupported('v1')).toBe(false);
    expect(sendAlert).toHaveBeenCalledWith('evm_close_acquire_window_failed', expect.anything());
  });
});
