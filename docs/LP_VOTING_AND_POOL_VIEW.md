# LP providers: voting weight, payouts and the vault pool view

How the backend treats vault tokens (VT) that holders put into a DEX pool, on Cardano and on
Robinhood Chain (EVM, Uniswap v4), and how the vault page shows the pool.

## The rule

**An LP provider's weight is the VT inside their pool position, valued at the snapshot.**
The other side of the pool (ADA on Cardano, ETH on Robinhood) gives no weight.

- Weight means ownership of the vault, and ownership is VT. Native tokens in a pool are not a
  claim on the vault.
- On Robinhood, payouts to LP providers go through `L4VALpShareRegistry`. Its `finalize` reverts
  (`ExceedsPoolVt`) if the recorded LP total is larger than the VT the PoolManager held at that
  timepoint. So payouts cannot count the ETH side even if we wanted to.
- Protocol-owned liquidity (positions held by the vault or by its LP adapter) never votes and is
  never paid as an LP share.

**Open product question:** should the ETH side of an LP position also give a vote, as an
incentive to provide liquidity? If yes, it can only apply to voting, never to payouts. Until it
is decided, do not change the rule above.

## Cardano

Code: `GovernanceService` snapshot, LP section
(`src/modules/vaults/phase-management/governance/governance.service.ts`).

DEX pools (Minswap, VyFi, …) are constant-product pools with fungible LP tokens. Each LP token
covers the whole price range, so every LP always holds both tokens.

1. Pools for the VT come from TapTools, with the VT locked in each pool and the pool's LP token.
2. The LP token holders are listed; DEX script addresses are filtered out.
3. Each holder gets `holderLp / activeLpSupply × vtLockedInPool` added to their snapshot balance.
4. The pool contract address is removed from the snapshot, so pool VT is not counted twice.

## Robinhood Chain (Uniswap v4)

Code: `EvmLpVotingService.attributeLpVt`
(`src/modules/vaults/phase-management/governance/evm-lp-voting.service.ts`), called by
`EvmSnapshotService` when a snapshot is taken (every 3 h, and for every new proposal).

The `VaultToken` excludes the PoolManager from voting, because it custodies the VT of every v4
pool. That VT is attributed back to position owners:

1. Pools: PoolManager `Initialize` events with the VT as either currency.
2. Positions: PoolManager `ModifyLiquidity` events with `sender = PositionManager`; `salt` is the
   position NFT id. Only positions minted through the official PositionManager are seen.
3. For each position at the snapshot block: owner (`ownerOf`), liquidity and tick range. Its VT is
   computed from its liquidity, its range and the pool price.
4. Positions owned by the vault or one of its LP adapters are skipped.

Result: `snapshot.lp_balances` (owner → VT). For V13 distributions the backend writes these
amounts to `L4VALpShareRegistry` (`record`, then `finalize`) so LP providers are paid without
doing anything.

### Difference from Cardano: concentrated liquidity

v4 positions have their own price range, so LP shares are not interchangeable.

| Position | Holds | VT counted |
|---|---|---|
| Full range | both tokens | its VT side, like a Cardano LP |
| In range (narrow) | both tokens | its VT side |
| Out of range, below the price | VT only | all of it |
| Out of range, above the price | ETH only | **0, so no vote and no payout** |

An ETH-only position gains weight on its own if the price enters its range and buyers take VT
from it into the position; the next snapshot picks that up. On Cardano this case cannot happen.

## Vault page: Liquidity pool block

API: `GET /vaults/:id/lp` → `EvmLiquidityService.getVaultLp`
(`src/modules/vaults/processing-tx/onchain/evm-liquidity.service.ts`), cached 30 s.
UI: `l4va-client/src/components/vault-profile/VaultLiquidityPool.jsx`.

For v4 pools the view covers **every** position in the pool, not only the vault's:

- Positions are found with `EvmV4PositionScanner` (the same discovery LP voting uses; log scans are
  incremental and cached per pool, starting at the vault's LP seeding transaction).
- Each position's token amounts come from its own range at the current price
  (`aggregateV4Positions`, `evm-v4-pool-view.math.ts`).
- **Pool total** is the sum over all positions, including out-of-range ones.
- **Share of pool** is by value (both sides in ETH at the pool price). Liquidity units of positions
  with different ranges cannot be compared, so a share by liquidity would be wrong.
- `positions[]` lists each position: owner, vault or not, in range or not, VT, ETH, value, share.
  The UI marks the vault's position, the connected wallet's ("You") and out-of-range ones.
- `activeLiquidity` is the in-range liquidity only (`StateView.getLiquidity`), for reference.

The share shown in the UI is a share of the pool's value. It is not the voting weight: voting and
payouts count only the VT inside a position (see the rule above).

Uniswap V2 pools (older vaults) are always full range, so the view still uses the pair reserves
and the vault's LP-token share.

## Not covered yet

- Whether Cardano distributions pay LP holders for pool VT the same way as the Robinhood
  registry does has not been checked.
- Positions added to the PoolManager directly by other contracts (not through the PositionManager)
  are not seen, on the page or in voting.
