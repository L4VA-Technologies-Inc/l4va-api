import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { keccak256, parseAbiItem, toBytes, type Address, type Hex } from 'viem';

import { EvmAdminSigner } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { chunkRelease, computeVtRelease } from './evm-lp-exit.formulas';
import { resolveVaultLpExitAdapter } from './evm-protocol-versions';
import { EvmSwapService } from './evm-swap.service';
import { VAULT_ABI } from './vault.abi';

import {
  fetchJsonWithRetry,
  isBaseDown,
  isBlockedHttpError,
  markBaseDown,
  resolveBlockscoutBases,
  withBlockscoutKey,
} from '@/common/http/http-retry';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

const NATIVE = '0x0000000000000000000000000000000000000000' as const;
const DEAD = '0x000000000000000000000000000000000000dead' as const;
/** Recipients per `releaseToken` transaction. */
const RELEASE_CHUNK = 100;
const LOG_CHUNK_BLOCKS = 10_000n;
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** The slice of `UniswapV4LiquidityAdapter` the exit reads and calls. */
const V4_LP_ADAPTER_ABI = [
  {
    type: 'function',
    name: 'positionsOf',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'liquidityOf',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'positionManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'poolManager',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'withdrawLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'LiquidityWithdrawn',
    inputs: [
      { name: 'vault', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: false },
    ],
  },
] as const;

const POSM_ABI = [
  {
    type: 'function',
    name: 'getPositionLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'uint128' }],
  },
] as const;

/** `LiquidityExitAdapter` (vault-contract-solidity/src/adapters/LiquidityExitAdapter.sol). */
export const LP_EXIT_ADAPTER_ABI = [
  { type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'unassignedNative',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'unassignedToken',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nativeOwed',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOwed',
    stateMutability: 'view',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'assign',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'nativeAmount', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'tokenAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'releaseToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Assigned',
    inputs: [
      { name: 'vault', type: 'address', indexed: true },
      { name: 'nativeAmount', type: 'uint256', indexed: false },
      { name: 'token', type: 'address', indexed: true },
      { name: 'tokenAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TokenReleased',
    inputs: [
      { name: 'vault', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'total', type: 'uint256', indexed: false },
      { name: 'recipients', type: 'uint256', indexed: false },
    ],
  },
] as const;

const VT_ABI = [
  {
    type: 'function',
    name: 'isExcludedHolder',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface LpExitResult {
  withdrawnTokenIds: bigint[];
  nativeReturned: bigint;
  /** `address(0)` when returned as native, else WETH. */
  returnedAs: Address | null;
  vtReleased: bigint;
  vtRecipients: number;
}

/**
 * Brings a vault's protocol-owned v4 LP back to its holders before termination.
 *
 * Deployed vaults cannot book ETH sent to them, so the position is withdrawn into
 * `LiquidityExitAdapter` and pulled back through `Vault.swap`, the one path that credits
 * `_nativeCustody`. The VT that comes out of the pool is handed to holders pro rata, which
 * gives the same redemption shares as burning it. Then `redeem` pays holders the pool's ETH.
 *
 *   1. authority: lpAdapter.withdrawLiquidity(tokenId, exitAdapter)   — per live position
 *   2. owner:     exitAdapter.assign(vault, unassignedNative, vt, unassignedVt)
 *   3. authority: vault.swap(1 base unit of a custody ERC-20 → ETH, or 1 wei ETH → WETH)
 *   4. owner:     exitAdapter.releaseToken(vault, vt, holders, amounts)  — chunked
 *
 * Every step is re-derived from chain state, so a crash at any point resumes on the next call.
 * The vault must be Locked or Active (`Vault.swap` gate): run it before
 * `beginTerminationPreparing`.
 *
 * Step 2 earmarks ALL unassigned balance for this vault. Run exits one vault at a time:
 * proceeds of two interleaved exits would otherwise be credited to whichever assigns first.
 */
@Injectable()
export class EvmLpExitService {
  private readonly logger = new Logger(EvmLpExitService.name);

  constructor(
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    private readonly swapService: EvmSwapService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource
  ) {}

  exitAdapterFor(vault: Vault): Address | null {
    const env = this.configService.get<string>('EVM_LP_EXIT_ADAPTER_ADDRESS')?.trim();
    return resolveVaultLpExitAdapter(vault, env ? (env as Address) : null);
  }

  /** v4 LP adapters among the vault's LP positions (non-v4 position assets are skipped). */
  async v4LpAdapters(vaultAddress: Address): Promise<Address[]> {
    const client = this.contractReader.publicClient;
    const total = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'totalLiquidityPositions',
    })) as bigint;
    const adapters = new Set<Address>();
    for (let i = 1n; i <= total; i++) {
      const p = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'getLiquidityPosition',
        args: [i],
      })) as { positionAsset: Address };
      const asset = p.positionAsset.toLowerCase() as Address;
      try {
        await client.readContract({
          address: asset,
          abi: V4_LP_ADAPTER_ABI,
          functionName: 'liquidityOf',
          args: [vaultAddress],
        });
        adapters.add(asset);
      } catch {
        // not a v4 adapter
      }
    }
    return [...adapters];
  }

  /**
   * VT that can never be redeemed: what sits on the Uniswap v4 PoolManager of each of the
   * vault's LP adapters, plus 0xdead. v4 seeding forfeits the part of a deposit that does not
   * fit the position to the PoolManager (`clear`), so a vault that ever had LP keeps a little
   * VT there forever, and `terminationOutstanding` never reaches 0.
   */
  async unredeemableVt(vaultAddress: Address, vt: Address): Promise<bigint> {
    const client = this.contractReader.publicClient;
    const holders = new Set<string>([DEAD.toLowerCase()]);
    for (const adapter of await this.v4LpAdapters(vaultAddress)) {
      const pm = (await client.readContract({
        address: adapter,
        abi: V4_LP_ADAPTER_ABI,
        functionName: 'poolManager',
      })) as Address;
      holders.add(pm.toLowerCase());
    }
    let total = 0n;
    for (const holder of holders) {
      total += (await client.readContract({
        address: vt,
        abi: VT_ABI,
        functionName: 'balanceOf',
        args: [holder as Address],
      })) as bigint;
    }
    return total;
  }

  /** Liquidity the vault still has in v4 pools, summed over its adapters. */
  async liquidityInPools(vaultAddress: Address): Promise<bigint> {
    let total = 0n;
    for (const adapter of await this.v4LpAdapters(vaultAddress)) {
      total += (await this.contractReader.publicClient.readContract({
        address: adapter,
        abi: V4_LP_ADAPTER_ABI,
        functionName: 'liquidityOf',
        args: [vaultAddress],
      })) as bigint;
    }
    return total;
  }

  /** Runs (or resumes) steps 1–4. A no-op for a vault with no LP and nothing earmarked. */
  async exitIntoVault(vault: Vault): Promise<LpExitResult> {
    const client = this.contractReader.publicClient;
    const vaultAddress = vault.contract_address as Address;
    const result: LpExitResult = {
      withdrawnTokenIds: [],
      nativeReturned: 0n,
      returnedAs: null,
      vtReleased: 0n,
      vtRecipients: 0,
    };

    const lpAdapters = await this.v4LpAdapters(vaultAddress);
    const exitAdapter = this.exitAdapterFor(vault);
    if (!exitAdapter) {
      if ((await this.liquidityInPools(vaultAddress)) > 0n) {
        throw new BadRequestException(
          `Vault ${vaultAddress} has v4 LP in a pool and no LiquidityExitAdapter is configured for its protocol ` +
            `version (or EVM_LP_EXIT_ADAPTER_ADDRESS). Refusing: the pool's ETH would not reach holders.`
        );
      }
      return result;
    }

    const vt = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'vaultToken',
    })) as Address;

    // ---- 1. withdraw every live position into the exit adapter -------------
    for (const adapter of lpAdapters) {
      const tokenIds = (await client.readContract({
        address: adapter,
        abi: V4_LP_ADAPTER_ABI,
        functionName: 'positionsOf',
        args: [vaultAddress],
      })) as readonly bigint[];
      if (tokenIds.length === 0) continue;
      const posm = (await client.readContract({
        address: adapter,
        abi: V4_LP_ADAPTER_ABI,
        functionName: 'positionManager',
      })) as Address;

      for (const tokenId of tokenIds) {
        const liq = (await client.readContract({
          address: posm,
          abi: POSM_ABI,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
        })) as bigint;
        if (liq === 0n) continue; // already withdrawn (burned)

        const tx = await this.adminSigner.sendAndConfirm(
          { address: adapter, abi: V4_LP_ADAPTER_ABI, functionName: 'withdrawLiquidity', args: [tokenId, exitAdapter] },
          ['LiquidityWithdrawn']
        );
        result.withdrawnTokenIds.push(tokenId);
        this.logger.log(`LP exit: vault=${vaultAddress} tokenId=${tokenId} → exitAdapter ${exitAdapter} tx=${tx.hash}`);
      }
    }

    // ---- 2. earmark what arrived ---------------------------------------------
    const [freeNative, freeVt] = await Promise.all([
      client.readContract({
        address: exitAdapter,
        abi: LP_EXIT_ADAPTER_ABI,
        functionName: 'unassignedNative',
      }) as Promise<bigint>,
      client.readContract({
        address: exitAdapter,
        abi: LP_EXIT_ADAPTER_ABI,
        functionName: 'unassignedToken',
        args: [vt],
      }) as Promise<bigint>,
    ]);
    if (freeNative > 0n || freeVt > 0n) {
      const tx = await this.adminSigner.sendAndConfirm(
        {
          address: exitAdapter,
          abi: LP_EXIT_ADAPTER_ABI,
          functionName: 'assign',
          args: [vaultAddress, freeNative, vt, freeVt],
        },
        ['Assigned']
      );
      this.logger.log(`LP exit: assigned native=${freeNative} vt=${freeVt} to ${vaultAddress} tx=${tx.hash}`);
    }

    // ---- 3. pull native into the vault's custody -----------------------------
    const owed = (await client.readContract({
      address: exitAdapter,
      abi: LP_EXIT_ADAPTER_ABI,
      functionName: 'nativeOwed',
      args: [vaultAddress],
    })) as bigint;
    if (owed > 0n) {
      const leg = await this.pickDustLeg(vaultAddress, vt, lpAdapters, exitAdapter);
      const operationId = keccak256(toBytes(`lp-exit:${vaultAddress.toLowerCase()}:${owed}:${Date.now()}`)) as Hex;
      const swap = await this.swapService.swap(vault.id, {
        operationId,
        adapter: exitAdapter,
        assetIn: leg.assetIn,
        amountIn: 1n,
        assetOut: leg.assetOut,
        minAmountOut: owed,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        route: '0x',
      });
      result.nativeReturned = owed;
      result.returnedAs = leg.assetOut;
      this.logger.log(
        `LP exit: ${owed} wei back in ${vaultAddress} custody as ${leg.assetOut === NATIVE ? 'ETH' : 'WETH'} ` +
          `(dust leg ${leg.assetIn}) tx=${swap.txHash}`
      );
    }

    // ---- 4. hand the pool's VT to holders ------------------------------------
    const vtOwed = (await client.readContract({
      address: exitAdapter,
      abi: LP_EXIT_ADAPTER_ABI,
      functionName: 'tokenOwed',
      args: [vaultAddress, vt],
    })) as bigint;
    if (vtOwed > 0n) {
      const balances = await this.holderBalances(vault, vt);
      const excluded = new Set<string>(
        [exitAdapter, vaultAddress, NATIVE, DEAD, ...lpAdapters].map(a => a.toLowerCase())
      );
      for (const adapter of lpAdapters) {
        const pm = (await client.readContract({
          address: adapter,
          abi: V4_LP_ADAPTER_ABI,
          functionName: 'poolManager',
        })) as Address;
        excluded.add(pm.toLowerCase());
      }
      for (const holder of balances.keys()) {
        if (excluded.has(holder)) continue;
        const isExcluded = (await client.readContract({
          address: vt,
          abi: VT_ABI,
          functionName: 'isExcludedHolder',
          args: [holder as Address],
        })) as boolean;
        if (isExcluded) excluded.add(holder);
      }

      const plan = computeVtRelease(vtOwed, balances, excluded);
      for (const chunk of chunkRelease(plan, RELEASE_CHUNK)) {
        const tx = await this.adminSigner.sendAndConfirm(
          {
            address: exitAdapter,
            abi: LP_EXIT_ADAPTER_ABI,
            functionName: 'releaseToken',
            args: [vaultAddress, vt, chunk.recipients, chunk.amounts],
          },
          ['TokenReleased']
        );
        this.logger.log(`LP exit: released VT to ${chunk.recipients.length} holders of ${vaultAddress} tx=${tx.hash}`);
      }
      result.vtReleased = plan.total;
      result.vtRecipients = plan.recipients.length;
    }

    return result;
  }

  /**
   * The input leg of the pull-back swap: 1 base unit of a custody ERC-20 (output native), else
   * 1 wei of native (output WETH). VT and LP receipts are never used: VT is not a swap leg and
   * receipts cannot be transferred.
   */
  private async pickDustLeg(
    vaultAddress: Address,
    vt: Address,
    lpAdapters: Address[],
    exitAdapter: Address
  ): Promise<{ assetIn: Address; assetOut: Address }> {
    const client = this.contractReader.publicClient;
    const skip = new Set([vt, ...lpAdapters].map(a => a.toLowerCase()));
    const custody = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'custodyTokens',
    })) as Address[];
    for (const token of custody) {
      if (skip.has(token.toLowerCase())) continue;
      const free = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'availableErc20ForOperations',
        args: [token],
      })) as bigint;
      if (free > 0n) return { assetIn: token, assetOut: NATIVE };
    }

    const freeNative = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'availableNativeForOperations',
    })) as bigint;
    if (freeNative > 0n) {
      const weth = (await client.readContract({
        address: exitAdapter,
        abi: LP_EXIT_ADAPTER_ABI,
        functionName: 'weth',
      })) as Address;
      return { assetIn: NATIVE, assetOut: weth };
    }
    throw new BadRequestException(
      `Vault ${vaultAddress} holds no free ERC-20 or native to use as the 1-unit input of the LP pull-back swap`
    );
  }

  /**
   * Current VT balances. Blockscout first; on failure (e.g. Cloudflare 403 on mainnet)
   * fall back to replaying VT Transfer logs from the vault's createVault block.
   */
  private async holderBalances(vault: Vault, vt: Address): Promise<Map<string, bigint>> {
    try {
      return await this.fetchHolderBalances(vt, vault.chain_id);
    } catch (err) {
      this.logger.warn(
        `LP exit: holders API failed for VT ${vt} (${(err as Error).message}); falling back to Transfer replay`
      );
      return this.replayHolderBalances(vault, vt);
    }
  }

  private async replayHolderBalances(vault: Vault, vt: Address): Promise<Map<string, bigint>> {
    const client = this.contractReader.publicClient;
    const createTx = await this.dataSource.getRepository(Transaction).findOne({
      where: { vault_id: vault.id, type: TransactionType.createVault, status: TransactionStatus.confirmed },
      order: { created_at: 'DESC' },
    });
    if (!createTx?.tx_hash) {
      throw new Error(`Cannot replay VT holders for vault ${vault.id}: no confirmed createVault tx`);
    }
    const receipt = await client.getTransactionReceipt({ hash: createTx.tx_hash as Hex });
    const latest = await client.getBlockNumber();

    const balances = new Map<string, bigint>();
    for (let from = receipt.blockNumber; from <= latest; from += LOG_CHUNK_BLOCKS) {
      const to = from + LOG_CHUNK_BLOCKS - 1n > latest ? latest : from + LOG_CHUNK_BLOCKS - 1n;
      const logs = await client.getLogs({ address: vt, event: TRANSFER_EVENT, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const { from: src, to: dst, value } = log.args;
        if (value === undefined) continue;
        if (src && src !== NATIVE) {
          const k = src.toLowerCase();
          balances.set(k, (balances.get(k) ?? 0n) - value);
        }
        if (dst && dst !== NATIVE) {
          const k = dst.toLowerCase();
          balances.set(k, (balances.get(k) ?? 0n) + value);
        }
      }
    }
    for (const [k, v] of balances) if (v <= 0n) balances.delete(k);
    return balances;
  }

  /**
   * Current VT balances from the Blockscout holders API (paged), trying every configured base
   * in order with retries. A base that hard-blocks (403) is put on cooldown.
   */
  private async fetchHolderBalances(vt: Address, chainId: number | string | undefined): Promise<Map<string, bigint>> {
    const errors: string[] = [];
    for (const base of resolveBlockscoutBases(this.configService, chainId)) {
      if (isBaseDown(base)) {
        errors.push(`${base}: on cooldown`);
        continue;
      }
      try {
        return await this.fetchHolderBalancesFrom(base, vt);
      } catch (err) {
        if (isBlockedHttpError(err)) markBaseDown(base);
        errors.push(`${base}: ${(err as Error).message}`);
      }
    }
    throw new Error(`All holders API bases failed: ${errors.join(' | ')}`);
  }

  private async fetchHolderBalancesFrom(base: string, vt: Address): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    let next: Record<string, unknown> | null = null;
    for (let page = 0; page < 500; page++) {
      const url = withBlockscoutKey(new URL(`${base}/tokens/${vt}/holders`), this.configService);
      for (const [k, v] of Object.entries(next ?? {})) if (v != null) url.searchParams.set(k, String(v));
      const data = await fetchJsonWithRetry<{ items?: any[]; next_page_params?: Record<string, unknown> | null }>(
        url.toString(),
        { timeoutMs: 20_000 }
      );
      for (const item of data.items ?? []) {
        const addr = String(item.address?.hash ?? '').toLowerCase();
        if (addr) balances.set(addr, BigInt(item.value));
      }
      next = data.next_page_params ?? null;
      if (!next) return balances;
    }
    throw new Error(`Holders API for ${vt} did not finish paging`);
  }
}
