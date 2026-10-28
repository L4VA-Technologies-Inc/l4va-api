import { parseEther, type Address, type Hex } from 'viem';

import type { TestApp } from './app';
import {
  ACCOUNTS,
  chainNow,
  deploy,
  increaseChainTime,
  loadArtifact,
  publicClient,
  read,
  send,
  walletFor,
  type AccountName,
} from './chain';

import { Proposal } from '@/database/proposal.entity';
import { SystemSettings } from '@/database/systemSettings.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { AcquireService } from '@/modules/vaults/phase-management/acquire/acquire.service';
import { ContributionService } from '@/modules/vaults/phase-management/contribution/contribution.service';
import { EvmGovernanceExecutionService } from '@/modules/vaults/phase-management/governance/evm-governance-execution.service';
import { EvmContributionBackfillService } from '@/modules/vaults/processing-tx/onchain/evm-contribution-backfill.service';
import { EvmVaultContributionService } from '@/modules/vaults/processing-tx/onchain/evm-vault-contribution.service';
import { VAULT_ABI } from '@/modules/vaults/processing-tx/onchain/vault.abi';
import { VaultsService } from '@/modules/vaults/vaults.service';
import { VaultArchetype } from '@/types/index-vault.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { ChainType } from '@/types/vault.types';

export const MINUTE = 60;
export const NATIVE = '0x0000000000000000000000000000000000000000';

/** On-chain VaultTypes.VaultStatus */
export enum OnChainVaultStatus {
  Pending,
  Active,
  Locked,
  Cancelled,
}

// ---------------------------------------------------------------------------
// Clock: the backend reads Date.now(), the contracts read block.timestamp.
// Only Date is faked, and it always follows the chain.
// ---------------------------------------------------------------------------

export async function syncClock(): Promise<void> {
  jest.setSystemTime((await chainNow()) * 1000);
}

export async function warp(seconds: number): Promise<void> {
  await increaseChainTime(seconds);
  await syncClock();
}

/**
 * Let a few seconds pass on both clocks. viem caches the latest block number
 * for 4s measured with Date.now(); under a frozen fake clock that cache never
 * expires and the indexer keeps reading a stale head.
 */
export async function settle(): Promise<void> {
  await warp(5);
}

export function useChainClock(): void {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

// ---------------------------------------------------------------------------
// Database state
// ---------------------------------------------------------------------------

const VAULT_TABLES = [
  'evm_allocations',
  'evm_contribution_valuations',
  'evm_valuation_snapshots',
  'evm_contributions',
  'evm_external_positions',
  'evm_index_rebalances',
  'claims',
  'assets',
  'transactions',
  'proposal',
  'snapshot',
  'vaults',
  'users',
];

/** Wipe vault state and pin the settings the scenarios rely on. */
export async function resetState(t: TestApp, settings: Record<string, unknown> = {}): Promise<void> {
  await t.dataSource.query(`TRUNCATE ${VAULT_TABLES.map(n => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await resetSettings(t, settings);
}

/** Replace system_settings with the scenario defaults plus overrides, and reload them. */
export async function resetSettings(t: TestApp, settings: Record<string, unknown> = {}): Promise<void> {
  await t.dataSource.query('DELETE FROM system_settings');
  await t.dataSource.getRepository(SystemSettings).save({
    data: {
      vault_archetypes_enabled: {
        [ChainType.cardano]: [VaultArchetype.standard],
        [ChainType.robinhood]: [VaultArchetype.standard, VaultArchetype.index_weighted],
      },
      // No protocol fee, so a contribution is a single contributeNative call.
      protocol_acquires_fee_evm: '0',
      protocol_fee_per_asset_evm: '0',
      ...settings,
    },
  });
  await t.app.get(SystemSettingsService).loadSettings();
}

export async function createUser(t: TestApp, name: AccountName): Promise<User> {
  return t.dataSource.getRepository(User).save({
    address: ACCOUNTS[name].address,
    name: `lifecycle-${name}`,
    chain_type: ChainType.robinhood,
  } as Partial<User>);
}

// ---------------------------------------------------------------------------
// Vault flows — same calls the client makes (useCreateEvmVault, useEvmAcquireTransaction)
// ---------------------------------------------------------------------------

export interface AcquireOnlyVaultOptions {
  acquireWindowMinutes?: number;
  /** In ETH, as the client sends it for Robinhood; the API minimum is 0.01. */
  minAcquireThreshold?: number;
}

/** Create and publish an acquire-only standard vault on Robinhood, returning its DB row. */
export async function createAcquireOnlyVault(
  t: TestApp,
  creator: User,
  creatorAccount: AccountName,
  opts: AcquireOnlyVaultOptions = {}
): Promise<Vault> {
  const vaultsService = t.app.get(VaultsService);
  const ticker = `T${Date.now() % 100000}`;
  const prepared = await vaultsService.createVault(creator.id, {
    chainType: ChainType.robinhood,
    vaultArchetype: VaultArchetype.standard,
    name: `Lifecycle ${ticker}`,
    type: 'cnt',
    privacy: 'public',
    valueMethod: 'lbe',
    vaultTokenTicker: ticker,
    description: 'lifecycle test vault',
    vaultImage: '',
    socialLinks: [],
    tags: [],
    contributorWhitelist: [],
    assetsWhitelist: [],
    acquirerWhitelist: [],
    contributionOpenWindowType: 'upon-vault-launch',
    contributionOpenWindowTime: null,
    acquireOpenWindowType: 'upon-asset-window-closing',
    acquireOpenWindowTime: null,
    // The client always sends contributionDuration, even for acquire-only vaults; without
    // it the API defaults the on-chain asset window to 7 days and the cycle cannot close sooner.
    contributionDuration: (opts.acquireWindowMinutes ?? 10) * MINUTE * 1000,
    acquireWindowDuration: (opts.acquireWindowMinutes ?? 10) * MINUTE * 1000,
    isAcquireOnly: true,
    tokensForAcquires: 100,
    acquireReserve: 0,
    liquidityPoolContribution: 0,
    minAcquireThreshold: opts.minAcquireThreshold ?? 0.01,
    allowAcquireExpansion: false,
    ftTokenSupply: 1_000_000,
    terminationType: 'dao',
    creationThreshold: 0.1,
    voteThreshold: 0,
    executionThreshold: 51,
    cosigningThreshold: 33,
  } as never);

  const factory = loadArtifact('VaultFactory');
  const hash = await walletFor(creatorAccount).writeContract({
    address: t.stack.factory,
    abi: factory.abi,
    functionName: 'createVault',
    args: [
      toBigInts(prepared.evmVaultConfig),
      BigInt(prepared.adminNonce),
      BigInt(prepared.deadline),
      prepared.adminSignature,
    ],
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`createVault reverted (${hash})`);

  await vaultsService.publishVault(creator.id, {
    chainType: ChainType.robinhood,
    vaultId: prepared.vaultId,
    txId: prepared.transactionId,
    txHash: hash,
  } as never);
  // publishVault applies the creation receipt in the background; do it in line.
  await (vaultsService as unknown as { applyEvmCreationReceipt(h: string): Promise<void> }).applyEvmCreationReceipt(
    hash
  );

  return getVault(t, prepared.vaultId);
}

/** Acquire with native ETH exactly as useEvmAcquireTransaction does. */
export async function acquireNative(
  t: TestApp,
  vault: Vault,
  user: User,
  account: AccountName,
  eth: string
): Promise<Hex> {
  const wei = parseEther(eth).toString();
  const created = await t.app.get(AcquireService).acquire(
    vault.id,
    {
      assets: [{ assetName: 'eth', policyId: NATIVE, type: 'eth', quantity: wei, metadata: { rawWei: true } }],
    } as never,
    user.id
  );

  const contributions = t.app.get(EvmVaultContributionService);
  const prepared = await contributions.prepareContribution(created.txId, user.id);
  if (prepared.feePayment) throw new Error('Unexpected protocol fee — resetState pins fees to zero');
  if (prepared.calls.length !== 1 || prepared.calls[0].functionName !== 'contributeNative') {
    throw new Error(`Expected one contributeNative call, got ${prepared.calls.map(c => c.functionName).join(', ')}`);
  }
  const call = prepared.calls[0];

  const hash = await walletFor(account).writeContract({
    address: prepared.vaultAddress,
    abi: VAULT_ABI,
    functionName: 'contributeNative',
    args: [toBigInts(call.authorization), call.signature],
    value: BigInt(call.value || wei),
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`contributeNative reverted (${hash})`);

  await contributions.confirmContribution(created.txId, hash, user.id, [hash]);
  await settle();
  await t.app.get(EvmContributionBackfillService).backfillVault(vault.id);
  return hash;
}

/** Store an executed proposal: the lifecycle and contribution flows read their config back from it. */
async function storeExecutedProposal(
  t: TestApp,
  vault: Vault,
  creator: User,
  proposalType: ProposalType,
  metadata: Proposal['metadata']
): Promise<Proposal> {
  const [snapshot] = await t.dataSource.query(
    `INSERT INTO snapshot (address_balances, vault_id, asset_id) VALUES ('{}', $1, 'lifecycle') RETURNING id`,
    [vault.id]
  );
  return t.dataSource.getRepository(Proposal).save({
    title: `Lifecycle ${proposalType}`,
    description: 'lifecycle test',
    status: ProposalStatus.EXECUTED,
    proposalType,
    executionDate: new Date(),
    snapshotId: snapshot.id,
    creatorId: creator.id,
    vaultId: vault.id,
    metadata,
  } as Partial<Proposal>);
}

/** Open an expansion cycle the way an executed EXPANSION proposal does, without the vote. */
export async function openExpansion(
  t: TestApp,
  vault: Vault,
  creator: User,
  minutes: number,
  evmAssets: Address[] = []
): Promise<void> {
  const proposal = await storeExecutedProposal(t, vault, creator, ProposalType.EXPANSION, {
    expansion: {
      duration: minutes * MINUTE * 1000,
      priceType: 'market',
      evmAssets: evmAssets.map(contractAddress => ({ contractAddress })),
    },
  });
  const execution = t.app.get(EvmGovernanceExecutionService) as unknown as {
    executeEvmExpansion(proposal: unknown, vault: { id: string }): Promise<boolean>;
  };
  if (!(await execution.executeEvmExpansion(proposal, { id: vault.id }))) {
    throw new Error('executeEvmExpansion did not open a cycle');
  }
}

/** Open an acquire-expansion cycle the way an executed ACQUIRE_EXPANSION proposal does. */
export async function openAcquireExpansion(
  t: TestApp,
  vault: Vault,
  creator: User,
  minutes: number,
  limitPrice?: number
): Promise<void> {
  const proposal = await storeExecutedProposal(t, vault, creator, ProposalType.ACQUIRE_EXPANSION, {
    acquireExpansion: {
      duration: minutes * MINUTE * 1000,
      ...(limitPrice ? { priceType: 'limit' as const, limitPrice } : { priceType: 'market' as const }),
    },
  });
  const execution = t.app.get(EvmGovernanceExecutionService) as unknown as {
    executeEvmAcquireExpansion(proposal: unknown, vault: { id: string }): Promise<boolean>;
  };
  if (!(await execution.executeEvmAcquireExpansion(proposal, { id: vault.id }))) {
    throw new Error('executeEvmAcquireExpansion did not open a cycle');
  }
}

/** Deploy a mock ERC20 and mint `amount` whole tokens (18 decimals) to each holder. */
export async function deployToken(holders: AccountName[], amount = '1000'): Promise<Address> {
  const token = await deploy('MockERC20', ['Lifecycle Token', 'LCT', 18]);
  const { abi } = loadArtifact('MockERC20');
  for (const holder of holders) await send('admin', token, abi, 'mint', [ACCOUNTS[holder].address, parseEther(amount)]);
  return token;
}

/**
 * Contribute an ERC20 exactly as useEvmContributeTransaction does: create the
 * transaction, fetch signed authorizations, approve + contribute, confirm.
 */
export async function contributeErc20(
  t: TestApp,
  vault: Vault,
  user: User,
  account: AccountName,
  token: Address,
  amount: string
): Promise<void> {
  const created = await t.app.get(ContributionService).contribute(
    vault.id,
    {
      assets: [
        {
          policyId: token,
          type: 'ft',
          standard: 'ERC20',
          assetName: 'LCT',
          quantity: amount,
          decimals: 18,
          metadata: { policyId: token, assetName: 'LCT', decimals: 18 },
        },
      ],
    } as never,
    user.id
  );

  const contributions = t.app.get(EvmVaultContributionService);
  const prepared = await contributions.prepareContribution(created.txId, user.id);
  if (prepared.feePayment) throw new Error('Unexpected protocol fee — resetState pins fees to zero');

  const hashes: Hex[] = [];
  const { abi: erc20 } = loadArtifact('MockERC20');
  for (const call of prepared.calls) {
    if (call.approval.required) {
      hashes.push(
        await send(account, call.approval.token, erc20, 'approve', [
          prepared.vaultAddress,
          BigInt(call.approval.amountOrTokenId),
        ])
      );
    }
    hashes.push(
      await send(account, prepared.vaultAddress, VAULT_ABI as never, call.functionName, [
        toBigInts(call.authorization),
        call.signature,
      ])
    );
  }
  await contributions.confirmContribution(created.txId, hashes[hashes.length - 1], user.id, hashes);
  await settle();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Wait for background handlers to index a cycle's contributions into the database. */
export async function waitForContributions(t: TestApp, vaultId: string, cycleId: number, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const [{ n }] = await t.dataSource.query(
      'SELECT count(*)::int AS n FROM evm_contributions WHERE vault_id = $1 AND cycle_id = $2',
      [vaultId, cycleId]
    );
    if (n >= count) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Cycle ${cycleId} of vault ${vaultId} never reached ${count} indexed contribution(s)`);
}

export async function getVault(t: TestApp, id: string): Promise<Vault> {
  return t.dataSource.getRepository(Vault).findOneOrFail({ where: { id } });
}

export async function onChainStatus(vault: Vault): Promise<OnChainVaultStatus> {
  return Number(
    await read<number>(vault.contract_address as Address, VAULT_ABI as never, 'status')
  ) as OnChainVaultStatus;
}

export async function onChainCycle(vault: Vault): Promise<bigint> {
  return read<bigint>(vault.contract_address as Address, VAULT_ABI as never, 'currentCycleId');
}

export async function adminNonce(): Promise<number> {
  return publicClient.getTransactionCount({ address: ACCOUNTS.admin.address });
}

export async function snapshotRow(
  t: TestApp,
  vaultId: string,
  cycleId: number
): Promise<{
  status: string;
  merkle_root: string;
  total_vt_allocation: string;
  total_native_allocation: string;
} | null> {
  const rows = await t.dataSource.query(
    `SELECT status, merkle_root, total_vt_allocation::text, total_native_allocation::text
       FROM evm_valuation_snapshots WHERE vault_id = $1 AND cycle_id = $2`,
    [vaultId, cycleId]
  );
  return rows[0] ?? null;
}

/** Contract args arrive from the API as decimal strings; the ABI wants bigints. */
function toBigInts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toBigInts) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toBigInts(v)])) as T;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value) as T;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value) as T;
  return value;
}
