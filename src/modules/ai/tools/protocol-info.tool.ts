import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';

import { VaultAiTool, VaultAiToolOutcome } from './vault-ai-tool.types';

export const PROTOCOL_INFO_TOOL = 'get_protocol_info';

const DOCS = 'https://l4va.gitbook.io/l4va-protocol';

// Condensed from the public GitBook docs (reviewed 2026-11-25). Keep it to facts that do not go stale
// quickly; live supply numbers belong on the transparency page, not here. Update when the docs change.
// The GitBook rewards page is out of date (2026-11-25), so it is not linked; rewards come from
// get_rewards_info, which mirrors the site.
const L4VA_PROTOCOL_REFERENCE = `In plain words (use this level first)
- L4VA lets anyone turn an investment idea into a vault: a basket of assets with its own token.
- People put in ETH (or ADA on Cardano) during the acquire phase and get the vault's token in return.
- Once enough is raised, the vault goes live: it buys the assets in the basket and the token becomes
  tradable on Uniswap.
- An AI manager keeps the basket on track within the creator's rules, and token holders vote on bigger
  changes.
- Holding the vault token is like holding a share of that basket; its price can move above or below
  what the basket is worth.

Details (only when the user asks for more)

What L4VA is
L4VA is a protocol for creating asset-backed strategy tokens ("create and own AI powered ETF tokens
backed by RWAs"). One idea, one vault, one token: the vault holds the portfolio (and its launch LP
position), and its Vault Token (VT) represents participation in that vault. Rules are set by the
creator, decisions are shaped by the holders, and AI helps turn the strategy into a portfolio and manage
it within those rules. "ETF-style" does not mean a regulated ETF, and a VT's market price can differ
from the value of the assets behind it.

Roles
Creator (configures strategy and launch), acquirers (fund the vault with supported crypto, e.g. ETH),
asset contributors (deposit allowed assets, where the vault enables that), the AI asset manager, and
holder governance.

Flow: Vault creation -> Acquire -> Activation -> Managed strategy
- Creation: describe the strategy, choose the asset whitelist (token contracts or native asset
  identifiers, not tickers), set target weights and balance management, configure the vault token
  (name, ticker, supply, allocation), set launch conditions (funding terms, minimum reserve, liquidity
  threshold), then launch the acquire phase.
- Acquire: acquirers connect a wallet on the vault's network, enter an amount, review the token
  allocation shown, sign and wait for confirmation. Never send funds to an address just because it
  appears in a social post.
- Activation: the vault must meet both its minimum reserve requirement and its liquidity threshold.
  On activation a Uniswap LP for the vault token is created (the position NFT is held by the vault)
  and the AI manager buys the whitelisted portfolio. Launch funds are split between LP liquidity and
  the portfolio purchase budget.
- Cancellation/refund terms are per vault; check the vault's own terms.

Assets, weights and balance management
The asset whitelist is what the vault may hold or trade; target weights are the desired allocation by
portfolio value and total 100%; balance management decides when deviations are corrected. Rebalancing
trades back toward the existing targets; reweighting changes the targets within approved bounds, and
anything beyond those bounds goes through governance. A target is not a guaranteed fill.

AI manager and governance
The AI manager recommends and executes only inside the vault's approved mandate; anything outside it
needs a governance or permission change. Holders vote on permitted actions through the vault's
governance and can review the mandate, balances, executed trades and governance records.

Chains
Robinhood Chain (EVM): Uniswap v4 for the vault token LP and for buying/rebalancing the underlying
assets. Cardano: native execution infrastructure. What assets and features are available depends on the
chain. Cross-chain vaults are on the roadmap, not live.

Fees
All protocol fees go to open-market $L4VA buybacks; bought tokens are split 25% burned, 25% treasury,
50% operations reserve. Gas, Uniswap LP trading fees and external RWA issuer charges are not part of
this. The fee actually charged is shown in the app.

$L4VA token
Utility, governance and rewards token, separate from vault tokens. Original supply 1,000,000,000
(900M on Robinhood Chain, 100M on Cardano); a finite 150M burn program brings it to 850M. Robinhood
Chain address 0x0C020Bef365D7001611EF1cEcd6084cdD6b73683 (18 decimals). Live supply, locks and burns:
${DOCS}/locks-and-burns/transparency

Docs pages (link the one that fits the question)
- Overview: ${DOCS}
- How the protocol fits together: ${DOCS}/market-opportunity/protocol-model
- Create a vault: ${DOCS}/create-a-vault
- Assets, weights & balance management: ${DOCS}/create-a-vault/weights-and-management
- Acquire, bond & activate: ${DOCS}/create-a-vault/acquire-and-activate
- AI strategy & governance: ${DOCS}/create-a-vault/ai-and-governance
- Uniswap: ${DOCS}/uniswap
- Tokenomics: ${DOCS}/tokenomics
- Locks & burns: ${DOCS}/locks-and-burns
- Roadmap: ${DOCS}/roadmap
- FAQ & official links: ${DOCS}/faq-and-links
- Website: https://l4va.com`;

/**
 * General protocol knowledge from the public docs, loaded only when the user asks how L4VA works so it
 * is not part of every turn's prompt.
 */
@Injectable()
export class ProtocolInfoTool implements VaultAiTool {
  readonly name = PROTOCOL_INFO_TOOL;

  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: PROTOCOL_INFO_TOOL,
      description:
        'Returns the official facts about the L4VA protocol from its docs: what L4VA and vault tokens are, the ' +
        'vault lifecycle (acquire, activation, managed strategy), weights and rebalancing, the AI manager and ' +
        'governance, supported chains, fees and buybacks, the $L4VA token, and links to the docs pages. Call it ' +
        'before answering any general question about how L4VA or the platform works. No arguments are needed.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  };

  async execute(): Promise<VaultAiToolOutcome> {
    return {
      result: {
        ok: true,
        reference: L4VA_PROTOCOL_REFERENCE,
        guidance:
          "Answer from this reference only, in the user's language. First answer simply: 2-3 short sentences " +
          'in everyday words, based on "In plain words", no jargon or numbers unless asked, then offer to explain ' +
          'more. Go into the Details only when the user asks a follow-up or a specific question, one level deeper ' +
          'each time, and add the link to the docs page that covers it. Never invent numbers, dates, fee rates ' +
          'or features that are not in it; if it does not cover the question, say so and link the docs overview. ' +
          'For rewards questions use get_rewards_info instead. If a vault is being built, return to it in one ' +
          'sentence. Keep vaultDraft unchanged.',
      },
    };
  }
}
