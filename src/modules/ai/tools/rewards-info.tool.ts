import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';

import { VaultAiTool, VaultAiToolOutcome } from './vault-ai-tool.types';

export const REWARDS_INFO_TOOL = 'get_rewards_info';

// Mirrors the Rewards page copy; update both together.
const L4VA_REWARDS_REFERENCE = `Overview
Users earn $L4VA by creating or interacting with vaults. The Oracle Vault is the first vault on the
protocol — it mints ORACLE for "Relics of Magma" NFTs. Total bonuses across staking and alignment are
capped at 20%.

Base staking rewards
Stake L4VA or VLRM tokens to earn base rewards from treasury budgets. These rewards are independent of
protocol rewards.

How to earn protocol rewards
Earn $L4VA through protocol activity:
- contributing assets into vaults
- acquiring
- providing liquidity for vault tokens (VT/ETH or VT/USDC pools)
- swapping vault tokens using the widget
- participating in governance

Vesting & unlocking
Protocol rewards are split 50% immediate and 50% vested over 4 weeks. To unlock the vested portion,
keep holding your vault tokens, either directly in your wallet or through eligible LP positions. The
system tracks your effective VT balance over time, and vested rewards unlock based on how much of the
required VT balance you maintain during the vesting period.

Claiming
Once rewards are unlocked from vesting, go to the Claims section and submit an on-chain claim
transaction; the unlocked $L4VA is transferred to your wallet. Unclaimed rewards stay safely in the
protocol until you are ready.

Protocol reward bonuses (alignment)
- Stake at least 100,000 L4VA: +5%
- Stake at least 20,000 VLRM: +5%
- Hold Oracle (ORACLE): +0.5% to +5%
- Full alignment (L4VA + VLRM + ORACLE): +5%
- Maximum total alignment bonus: 20% (capped)`;

/**
 * Reference facts about L4VA rewards, loaded only when the user asks about them so the text is not
 * part of every turn's prompt.
 */
@Injectable()
export class RewardsInfoTool implements VaultAiTool {
  readonly name = REWARDS_INFO_TOOL;

  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: REWARDS_INFO_TOOL,
      description:
        'Returns the official facts about L4VA rewards ("lava rewards"): what they are, how to earn them, ' +
        'whether vaults earn them, base staking, vesting and unlocking, claiming, and alignment bonuses. ' +
        'Call it before answering any question about rewards. No arguments are needed.',
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
        reference: L4VA_REWARDS_REFERENCE,
        guidance:
          "Answer the question from this reference only, in a few short sentences in the user's language, then " +
          'return to the vault in one sentence. Never invent amounts, rates, APYs, dates or eligibility rules that ' +
          'are not in the reference; if it does not cover the question, say so and point to the Rewards page. ' +
          'Creating a vault, contributing, acquiring, providing VT liquidity, swapping its tokens and voting all ' +
          'earn protocol rewards. Keep vaultDraft unchanged.',
      },
    };
  }
}
