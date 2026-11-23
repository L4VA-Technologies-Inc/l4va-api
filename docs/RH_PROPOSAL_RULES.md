# Robinhood vault proposals: what happens when

How governance proposals behave on Robinhood vaults, as of November 23, 2026.

Each rule is marked:
- **Fixed**: built into the vault itself. Changing it needs a new vault version.
- **Ours**: a product choice. We can change it.

## Words used here

- **Locked**: the vault is not raising money right now. Most actions need this.
- **Expansion running**: the vault is raising more money (an expansion or acquire expansion is open).
- **Unpaid tokens**: after a raise closes, new vault tokens go out after a safety delay (24 hours, or less if approved early). Until they are sent, the vault still "owes" them.
- **Frozen**: the vault was paused for a safety check. Nothing can happen until it is unpaused.

## What can happen to a proposal after the vote passes

- **Runs**: it happens right away.
- **Waits**: it cannot happen yet. It runs by itself as soon as it can, however long that takes. The proposal page shows "Waiting to run" and the reason. If it waits more than 3 days, the team gets an alert.
- **Rejected**: things changed since the vote, so it can never happen as voted. The page shows why, and the person who created it gets their proposal fee back.
- **Stuck**: something unexpected went wrong several times in a row. The team gets an alert and has to look at it.

## 1. Creating a proposal

| Situation | What you can create | Rule |
|---|---|---|
| Vault locked | Any proposal | Ours |
| Expansion running | Only a distribution | Ours |
| The vault is being terminated | Nothing | Ours |
| A termination vote is already open | No second termination | Ours |
| An expansion vote is already open, or one passed and has not started | No second expansion | Ours |
| The vault already has 8 distributions open | No new distribution | Fixed |
| Acquire expansion shorter than 24 hours | Not allowed | Fixed |
| Acquire expansion at market price | Not allowed, fixed price only | Ours (not built yet) |
| Acquire expansion that would create more than 25 % new tokens | Not allowed | Fixed (25 % is the default per vault) |

## 2. When a passed proposal waits

| Proposal | Waits while | Rule |
|---|---|---|
| Any | The vault is frozen | Fixed |
| Expansion | Another expansion is still running | Fixed |
| Expansion | The vault is still finishing the last raise (setting up its trading pool, buying the basket) | Ours |
| Termination | An expansion is running | Fixed |
| Termination | Tokens or money from the last raise are still unpaid | Fixed |
| Distribution | Tokens from the last raise are still unpaid | Fixed |

Trades, swaps and basket changes do **not** wait for an expansion. They only use money the vault
already owns, never the money being raised.

## 3. When a passed proposal is rejected

| Proposal | Rejected when |
|---|---|
| Trade / swap | The vault no longer has enough free money for all its trades (for example, another proposal spent it). Nothing is traded, so it is never half done. |
| Distribution | The vault no longer has enough free money for the amount, and it has not started yet. |
| Distribution | The vault started terminating before the distribution started. The money reaches holders through the termination instead. |

## 4. When a passed proposal can get stuck

A trade is tried again a few times and then reported to the team if:
- there is no longer a way to trade that token (its market was removed or dried up), or
- the price moved too much at the moment of the trade.

## 5. Proposals that overlap

| Case | What happens |
|---|---|
| Two expansions | Only one can be voted on at a time. If an older one passes while another expansion runs, it waits and starts right after. |
| Termination while a distribution is already paying out | Allowed. Holders still receive the distribution, and also their share of the termination. The two never use the same money. |
| Termination passes before a passed distribution has started | The distribution is rejected. |
| Distribution right after a raise closes | Waits until the new tokens from that raise are sent (up to about a day). |
| Trade or basket change during an expansion | Runs, using only money the vault already owns. |
| Who can vote | Holders at the moment the proposal was created. Tokens bought later (for example in an expansion) do not vote on it. |

## 6. Timings and limits

| What | Value | Rule |
|---|---|---|
| An expansion that creates new tokens stays open at least | 24 hours, even if its target is reached sooner | Fixed |
| New tokens from a raise are sent after | 24 hours (can be approved earlier; 1 hour on the test site) | Can be set between 1 hour and 7 days |
| Distribution payouts start after | 1 hour on the test site | Can be set between 1 hour and 7 days |
| Holders can claim a distribution for | 180 days | Ours (at least 90 days) |
| Distributions open at once | 8 | Fixed |
| After the claim period ends | Whatever nobody claimed goes to the L4VA treasury. Holders are paid automatically first, so this is usually very little. | Fixed |
| New tokens one expansion can create | 25 % of the supply by default | Set per vault when it is created |

## 7. Decisions for product

- **Waiting has no time limit.** A proposal can run long after the vote, when conditions (price, who holds tokens) have changed. We could instead drop it after a number of days.
- **Unclaimed distribution money goes to the L4VA treasury**, not back to holders. Changing that needs a new vault version.
- **Trades that fail on price or a missing market are retried**, then reported. We could reject them right away instead.
- **An acquire expansion cannot end early** when its target is reached. It always stays open 24 hours. This protects holders if a team key is ever stolen.
