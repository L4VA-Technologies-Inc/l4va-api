import { parseEther } from 'viem';

import { createTestApp, type TestApp } from './helpers/app';
import { ACCOUNTS } from './helpers/chain';
import {
  MINUTE,
  OnChainVaultStatus,
  acquireNative,
  adminNonce,
  createAcquireOnlyVault,
  createUser,
  onChainCycle,
  openAcquireExpansion,
  openExpansion,
  getVault,
  onChainStatus,
  resetSettings,
  resetState,
  snapshotRow,
  syncClock,
  useChainClock,
  warp,
} from './helpers/scenario';

import { User } from '@/database/user.entity';
import { EMPTY_CYCLE_ROOT } from '@/modules/vaults/processing-tx/onchain/evm-allocation.service';
import { VaultStatus } from '@/types/vault.types';

describe('EVM cycle close', () => {
  let t: TestApp;
  let creator: User;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    t = await createTestApp();
    useChainClock();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await t?.close();
  });

  beforeEach(async () => {
    await syncClock();
    await resetState(t);
    creator = await createUser(t, 'creator');
    alice = await createUser(t, 'alice');
    bob = await createUser(t, 'bob');
  });

  it('locks an acquire-only vault whose raise met the threshold', async () => {
    const vault = await createAcquireOnlyVault(t, creator, 'creator', {
      acquireWindowMinutes: 10,
      minAcquireThreshold: 0.5,
    });
    await t.tick();
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.acquire);

    await acquireNative(t, vault, alice, 'alice', '0.4');
    await acquireNative(t, vault, bob, 'bob', '0.3');

    await warp(11 * MINUTE);
    await t.tick();

    const snapshot = await snapshotRow(t, vault.id, 1);
    expect(snapshot?.status).toBe('confirmed');
    expect(BigInt(snapshot!.total_vt_allocation)).toBeGreaterThan(0n);
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);
    expect(await onChainStatus(vault)).toBe(OnChainVaultStatus.Locked);

    // Every on-chain contribution is indexed and gets an allocation.
    const contributions = await t.dataSource.query(
      'SELECT lower(contributor) AS contributor, amount::text FROM evm_contributions WHERE vault_id = $1 ORDER BY amount DESC',
      [vault.id]
    );
    expect(contributions).toEqual([
      { contributor: ACCOUNTS.alice.address.toLowerCase(), amount: parseEther('0.4').toString() },
      { contributor: ACCOUNTS.bob.address.toLowerCase(), amount: parseEther('0.3').toString() },
    ]);
    const allocated = await t.dataSource.query(
      'SELECT lower(contributor) AS contributor FROM evm_allocations WHERE vault_id = $1 ORDER BY 1',
      [vault.id]
    );
    expect(allocated.map((r: { contributor: string }) => r.contributor).sort()).toEqual(
      [ACCOUNTS.alice.address, ACCOUNTS.bob.address].map(a => a.toLowerCase()).sort()
    );
  });

  it('does not send another transaction on later ticks', async () => {
    const vault = await createAcquireOnlyVault(t, creator, 'creator', { acquireWindowMinutes: 10 });
    await t.tick();
    await acquireNative(t, vault, alice, 'alice', '0.2');
    await warp(11 * MINUTE);
    await t.tick();
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);

    const nonce = await adminNonce();
    await t.tick(3);
    expect(await adminNonce()).toBe(nonce);
  });

  it('cancels a raise that missed the threshold and refunds the acquirers', async () => {
    const vault = await createAcquireOnlyVault(t, creator, 'creator', {
      acquireWindowMinutes: 10,
      minAcquireThreshold: 1,
    });
    await t.tick();
    await acquireNative(t, vault, alice, 'alice', '0.2');

    await warp(11 * MINUTE);
    await t.tick(3);

    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.failed);
    expect(await onChainStatus(vault)).toBe(OnChainVaultStatus.Cancelled);
    expect(await snapshotRow(t, vault.id, 1)).toBeNull();
    const [contribution] = await t.dataSource.query('SELECT status FROM evm_contributions WHERE vault_id = $1', [
      vault.id,
    ]);
    expect(contribution.status).toBe('refunded');
  });

  it('closes an expansion cycle nobody contributed to and keeps the vault locked', async () => {
    const vault = await createAcquireOnlyVault(t, creator, 'creator', { acquireWindowMinutes: 10 });
    await t.tick();
    await acquireNative(t, vault, alice, 'alice', '0.2');
    await warp(11 * MINUTE);
    await t.tick();
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);

    await openExpansion(t, vault, 10);
    expect(await onChainCycle(vault)).toBe(2n);
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.expansion);

    await warp(11 * MINUTE);
    await t.tick();

    const snapshot = await snapshotRow(t, vault.id, 2);
    expect(snapshot).toMatchObject({
      status: 'confirmed',
      merkle_root: EMPTY_CYCLE_ROOT,
      total_vt_allocation: '0',
      total_native_allocation: '0',
    });
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);
    expect(await onChainStatus(vault)).toBe(OnChainVaultStatus.Locked);
    expect(t.alerts).not.toHaveBeenCalled();
  });

  it('closes an acquire-expansion cycle when its governance duration ends', async () => {
    const vault = await createAcquireOnlyVault(t, creator, 'creator', { acquireWindowMinutes: 10 });
    await t.tick();
    await acquireNative(t, vault, alice, 'alice', '0.2');
    await warp(11 * MINUTE);
    await t.tick();
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);

    await openAcquireExpansion(t, vault, creator, 10, 1000);
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.acquire_expansion);
    await acquireNative(t, vault, bob, 'bob', '0.1');

    await warp(11 * MINUTE);
    await t.tick();

    const snapshot = await snapshotRow(t, vault.id, 2);
    expect(snapshot?.status).toBe('confirmed');
    // limit price: 1000 VT per 1 ETH → 0.1 ETH buys 100 VT
    expect(BigInt(snapshot!.total_vt_allocation)).toBe(100n * 10n ** 18n);
    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);
    expect(await onChainStatus(vault)).toBe(OnChainVaultStatus.Locked);
  });

  it('still finishes running cycles when evm_enabled is off', async () => {
    const vault = await createAcquireOnlyVault(t, creator, 'creator', { acquireWindowMinutes: 10 });
    await t.tick();
    await acquireNative(t, vault, alice, 'alice', '0.2');

    await resetSettings(t, { evm_enabled: false });
    await warp(11 * MINUTE);
    await t.tick();

    expect((await getVault(t, vault.id)).vault_status).toBe(VaultStatus.locked);
    expect(await onChainStatus(vault)).toBe(OnChainVaultStatus.Locked);
  });
});
