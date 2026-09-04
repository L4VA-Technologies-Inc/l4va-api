/**
 * TGE liquidity keeper — creates the initial L4VA/ETH pool on Robinhood Chain
 * once the presale has ended.
 *
 * This is the `lpExecutor` referenced by `L4VALiquidityEscrow`. The on-chain
 * split of responsibilities is deliberate:
 *
 *   L4VAPresale          routes the LP share of each purchase into the escrow
 *   L4VALiquidityEscrow  gates it, releasing only once the sale is ENDED, and
 *                        only to this executor
 *   this script          turns the released ETH + the L4VA side into a pool
 *
 * Pool creation is not done on-chain because Uniswap v4 pool construction is a
 * large, unaudited surface and the escrow holds real proceeds. The escrow does
 * the part that must be trustless (separating and gating funds); this does the
 * part that benefits from being fixable.
 *
 * SAFETY: dry-run by default. Nothing is broadcast without --broadcast.
 *
 * Usage:
 *   # 1. Dry run — prints every value and the built calldata, sends nothing
 *   npx ts-node src/scripts/lp/create-initial-pool.ts
 *
 *   # 2. For real
 *   npx ts-node src/scripts/lp/create-initial-pool.ts --broadcast
 *
 * Required env:
 *   UNISWAP_API_KEY     LP API key (https://developers.uniswap.org/dashboard)
 *   LP_EXECUTOR_KEY     Private key of the escrow's immutable lpExecutor
 *   L4VA_TOKEN          Deployed L4VAToken address
 *   LP_ESCROW           Deployed L4VALiquidityEscrow address
 *   TGE_PRICE_USD       L4VA price at TGE, e.g. 0.003
 *   ETH_USD_PRICE       ETH/USD at pool creation, e.g. 3000
 *
 * Optional env:
 *   LP_PROTOCOL         V3 | V4          (default V3 — see pool-survey.ts)
 *   LP_FEE              fee tier         (default 10000 = 1%, typical for a new token)
 *   LP_TICK_SPACING     tick spacing     (default 200, pairs with the 1% tier)
 *   LP_PRICE_FLOOR_PCT  lower bound as % of TGE price (default 50)
 *   LP_PRICE_CEIL_MULT  upper bound as a multiple of TGE price (default 20)
 *   LP_SLIPPAGE         percent, default 1
 *   RPC_URL             defaults to the Robinhood mainnet RPC
 */

import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  NATIVE_ETH,
  ROBINHOOD_CHAIN_ID,
  fmtEth,
  fmtToken,
  lpFetch,
  readContract,
  requireAddress,
  robinhoodChain,
  sortTokens,
  sqrtRatioX96,
  validateLpTransaction,
} from './shared';

const BROADCAST = process.argv.includes('--broadcast');

// Minimal views onto our own contracts.
// Declared with `parseAbi` to match the convention in taptools.service.ts —
// a plain `as const` array trips viem's readContract overload resolution under
// this project's tsconfig.
const ESCROW_ABI = parseAbi([
  'function releasable() view returns (bool)',
  'function release()',
  'function totalReceived() view returns (uint256)',
  'function totalReleased() view returns (uint256)',
  'function presale() view returns (address)',
]);

const PRESALE_ABI = parseAbi(['function phase() view returns (uint8)']);

const ERC20_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);

const PHASE_NAMES = ['INACTIVE', 'WHITELIST', 'PUBLIC', 'ENDED'];

function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`${name} not set`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number (got ${raw})`);
  return n;
}

async function main() {
  // ── Config ────────────────────────────────────────────────────────────────
  const l4vaToken = requireAddress(process.env.L4VA_TOKEN, 'L4VA_TOKEN');
  const escrowAddr = requireAddress(process.env.LP_ESCROW, 'LP_ESCROW');

  const tgePriceUsd = envNumber('TGE_PRICE_USD');
  const ethUsdPrice = envNumber('ETH_USD_PRICE');

  const protocol = (process.env.LP_PROTOCOL ?? 'V3').toUpperCase();
  if (protocol !== 'V3' && protocol !== 'V4') {
    throw new Error(`LP_PROTOCOL must be V3 or V4 (got ${protocol})`);
  }

  const fee = envNumber('LP_FEE', 10_000);
  const tickSpacing = envNumber('LP_TICK_SPACING', 200);
  const floorPct = envNumber('LP_PRICE_FLOOR_PCT', 50);
  const ceilMult = envNumber('LP_PRICE_CEIL_MULT', 20);
  const slippageTolerance = envNumber('LP_SLIPPAGE', 1);

  const key = process.env.LP_EXECUTOR_KEY;
  if (!key) throw new Error('LP_EXECUTOR_KEY not set');
  const account = privateKeyToAccount(key as `0x${string}`);

  const rpcUrl = process.env.RPC_URL ?? robinhoodChain.rpcUrls.default.http[0];
  // Widen the client type, as taptools.service.ts does: viem's fully-inferred
  // client makes readContract's parameter union unsatisfiable under this
  // project's tsconfig.
  const publicClient: ReturnType<typeof createPublicClient> = createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });

  console.log('=== L4VA initial pool creation ===');
  console.log(`Mode        : ${BROADCAST ? 'BROADCAST' : 'DRY RUN (no transactions sent)'}`);
  console.log(`Chain       : Robinhood ${ROBINHOOD_CHAIN_ID}`);
  console.log(`Executor    : ${account.address}`);
  console.log(`Protocol    : ${protocol}  fee=${fee}  tickSpacing=${tickSpacing}`);
  console.log('');

  // ── 1. Verify the sale has actually ended ─────────────────────────────────
  const presaleAddr = await readContract<`0x${string}`>(publicClient, {
    address: escrowAddr,
    abi: ESCROW_ABI,
    functionName: 'presale',
  });

  const phase = await readContract<number>(publicClient, {
    address: presaleAddr,
    abi: PRESALE_ABI,
    functionName: 'phase',
  });

  console.log(`Presale     : ${presaleAddr}  phase=${PHASE_NAMES[phase] ?? phase}`);
  if (phase !== 3) {
    console.log('');
    console.log('Sale has not ended. Nothing to do yet.');
    console.log('(The escrow refuses to release before ENDED, so this would fail anyway.)');
    return;
  }

  // ── 2. Release escrowed ETH, if any is still sitting there ────────────────
  const releasable = await readContract<boolean>(publicClient, {
    address: escrowAddr,
    abi: ESCROW_ABI,
    functionName: 'releasable',
  });

  const escrowBalance = await publicClient.getBalance({ address: escrowAddr });
  console.log(`Escrow      : ${escrowAddr}  balance=${fmtEth(escrowBalance)}  releasable=${releasable}`);

  if (releasable) {
    if (BROADCAST) {
      const hash = await walletClient.writeContract({
        address: escrowAddr,
        abi: ESCROW_ABI,
        functionName: 'release',
        account,
        chain: robinhoodChain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  released -> ${hash}`);
    } else {
      console.log('  [dry run] would call escrow.release()');
    }
  }

  // ── 3. Check both sides of the pair are actually in hand ──────────────────
  const ethBalance = await publicClient.getBalance({ address: account.address });
  const l4vaBalance = await readContract<bigint>(publicClient, {
    address: l4vaToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  console.log('');
  console.log(`Executor ETH : ${fmtEth(ethBalance)}`);
  console.log(`Executor L4VA: ${fmtToken(l4vaBalance)}`);

  if (l4vaBalance === 0n) {
    throw new Error(
      'Executor holds no L4VA. The escrow only supplies the ETH side — the paired L4VA ' +
        'must be transferred here from the treasury allocation BEFORE the sale ends, or ' +
        'pool creation cannot run unattended.'
    );
  }

  // Keep a gas buffer; do not try to LP the entire balance.
  const gasBuffer = parseUnits('0.01', 18);
  if (ethBalance <= gasBuffer) throw new Error(`Executor ETH balance too low: ${fmtEth(ethBalance)}`);
  const ethForLp = ethBalance - gasBuffer;

  // ── 4. Price → sqrtRatioX96 ───────────────────────────────────────────────
  // Uniswap prices are token1-per-token0 in raw units, ordered by ascending
  // address. Native ETH is the zero address, so it always sorts first.
  const [token0Address, token1Address] = sortTokens(NATIVE_ETH, l4vaToken);
  const ethIsToken0 = token0Address.toLowerCase() === NATIVE_ETH;

  // L4VA per ETH, as an exact rational: (ETH/USD) / (L4VA/USD).
  // Scale by 1e9 so fractional cent prices stay integral.
  const SCALE = 1_000_000_000n;
  const l4vaPerEthNum = BigInt(Math.round(ethUsdPrice * 1e9));
  const l4vaPerEthDen = BigInt(Math.round(tgePriceUsd * 1e9));
  void SCALE;

  const [num, den] = ethIsToken0
    ? [l4vaPerEthNum, l4vaPerEthDen] // token1 (L4VA) per token0 (ETH)
    : [l4vaPerEthDen, l4vaPerEthNum]; // inverted

  const initialPrice = sqrtRatioX96(num, den);
  const l4vaPerEth = Number(l4vaPerEthNum) / Number(l4vaPerEthDen);

  console.log('');
  console.log(`TGE price    : $${tgePriceUsd} / L4VA   (ETH @ $${ethUsdPrice})`);
  console.log(`Implied rate : ${l4vaPerEth.toLocaleString('en-US')} L4VA per ETH`);
  console.log(`token0       : ${token0Address}${ethIsToken0 ? '  (native ETH)' : ''}`);
  console.log(`token1       : ${token1Address}${ethIsToken0 ? '' : '  (native ETH)'}`);
  console.log(`initialPrice : ${initialPrice}  (sqrtRatioX96)`);

  // ── 5. Price range ────────────────────────────────────────────────────────
  // Denominated in L4VA-per-ETH when ETH is token0, so a HIGHER L4VA price in
  // USD means FEWER L4VA per ETH — the bounds invert accordingly.
  const priceLow = ethIsToken0 ? l4vaPerEth / ceilMult : (l4vaPerEth * floorPct) / 100;
  const priceHigh = ethIsToken0 ? (l4vaPerEth * 100) / floorPct : l4vaPerEth * ceilMult;

  const priceBounds = {
    minPrice: priceLow.toString(),
    maxPrice: priceHigh.toString(),
    quotedTokenAddress: token1Address,
  };
  console.log(
    `Range        : ${priceLow.toPrecision(6)} – ${priceHigh.toPrecision(6)} ` +
      `(token1 per token0; API will snap to ticks)`
  );

  // ── 6. Approvals ──────────────────────────────────────────────────────────
  const independentToken = { tokenAddress: l4vaToken, amount: l4vaBalance.toString() };

  const approval = await lpFetch<{
    transactions: { transaction: any }[];
    v4BatchPermitData?: any;
    kycRequiredWarnings?: { kycUrl: string; tokenAddress: string }[];
  }>('/lp/check_approval', {
    walletAddress: account.address,
    protocol,
    chainId: ROBINHOOD_CHAIN_ID,
    lpTokens: [independentToken],
    action: 'CREATE',
  });

  if (approval.kycRequiredWarnings?.length) {
    throw new Error(
      `Wallet is not allowlisted for a permissioned token in this pool. KYC: ${approval.kycRequiredWarnings
        .map(w => w.kycUrl)
        .join(', ')}`
    );
  }

  console.log('');
  console.log(`Approvals    : ${approval.transactions?.length ?? 0} pending`);

  for (const a of approval.transactions ?? []) {
    // Sign a.transaction — never the wrapper object.
    validateLpTransaction(a.transaction, 'approval');
    if (BROADCAST) {
      const hash = await walletClient.sendTransaction(a.transaction);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  approved -> ${hash}`);
    } else {
      console.log(`  [dry run] would send approval to ${a.transaction.to}`);
    }
  }

  // v4 batch permit: sign offchain, send the ORIGINAL payload back with the sig.
  let signature: string | undefined;
  const permit = approval.v4BatchPermitData;
  if (permit) {
    // The permit is proto-encoded: chainId arrives as an enum-name string and
    // each types entry is wrapped in { fields }. Normalize for signing only.
    const types = Object.fromEntries(
      Object.entries(permit.types as Record<string, any>).map(([k, v]) => [k, v.fields])
    );
    signature = await walletClient.signTypedData({
      account,
      domain: { ...permit.domain, chainId: ROBINHOOD_CHAIN_ID },
      types: types as any,
      message: permit.values,
      primaryType: 'PermitBatch',
    });
    console.log('  v4 batch permit signed');
  }

  // ── 7. Build the create transaction ───────────────────────────────────────
  const createBody: Record<string, unknown> = {
    walletAddress: account.address,
    chainId: ROBINHOOD_CHAIN_ID,
    protocol,
    independentToken,
    newPool: {
      token0Address,
      token1Address,
      fee,
      tickSpacing,
      initialPrice,
      ...(protocol === 'V4' ? { hooks: NATIVE_ETH } : {}), // no hooks for a plain launch pool
    },
    priceBounds,
    slippageTolerance,
    nativeTokenBalance: ethForLp.toString(),
    simulateTransaction: true,
  };
  // Send permit fields as a matched pair, or omit both.
  if (permit && signature) {
    createBody.batchPermitData = permit; // note: /lp/create uses `batchPermitData`
    createBody.signature = signature;
  }

  const created = await lpFetch<{
    token0: { tokenAddress: string; amount: string };
    token1: { tokenAddress: string; amount: string };
    adjustedMinPrice: string;
    adjustedMaxPrice: string;
    tickLower: number;
    tickUpper: number;
    create: any;
    gasFee?: string;
  }>('/lp/create', createBody);

  console.log('');
  console.log('=== Position to be created ===');
  console.log(`token0 amount: ${created.token0.amount}  (${created.token0.tokenAddress})`);
  console.log(`token1 amount: ${created.token1.amount}  (${created.token1.tokenAddress})`);
  // Show the tick-snapped values, not the requested ones.
  console.log(`adjusted range: ${created.adjustedMinPrice} – ${created.adjustedMaxPrice}`);
  console.log(`ticks         : ${created.tickLower} … ${created.tickUpper}`);
  if (created.gasFee) console.log(`est. gas      : ${formatEther(BigInt(created.gasFee))} ETH`);

  validateLpTransaction(created.create, 'create');

  if (!BROADCAST) {
    console.log('');
    console.log('DRY RUN — nothing sent. Re-run with --broadcast to execute.');
    console.log('Check the amounts and adjusted range above before you do.');
    return;
  }

  // Pool price moves; a stale build can revert. Anything older than ~30s
  // should be rebuilt rather than broadcast.
  const hash = await walletClient.sendTransaction(created.create);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log('');
  console.log('=== Pool created ===');
  console.log(`tx     : ${hash}`);
  console.log(`status : ${receipt.status}`);
  console.log(`explorer: ${robinhoodChain.blockExplorers.default.url}/tx/${hash}`);
  console.log('');
  console.log('Next: verify the pool and token on Blockscout, and confirm it is');
  console.log('routable in the Uniswap interface before announcing.');
}

main().catch(err => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
