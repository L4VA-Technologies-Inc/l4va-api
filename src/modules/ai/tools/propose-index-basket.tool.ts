import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';

import { VaultAiTool, VaultAiToolContext, VaultAiToolOutcome } from './vault-ai-tool.types';

import { IndexSupportedAsset, IndexVaultService } from '@/modules/vaults/index-vault/index-vault.service';
import { INDEX_MAX_ASSETS, INDEX_MIN_WEIGHT_BPS, VaultArchetype } from '@/types/index-vault.types';

export const PROPOSE_INDEX_BASKET_TOOL = 'propose_index_basket';

/** Mirrors the client's INDEX_DEFAULT_RESERVE_BPS and the 50% cap in IndexVaultService.buildConfig. */
const DEFAULT_RESERVE_BPS = 1000;
const MAX_RESERVE_BPS = 5000;

/**
 * Lets the assistant build the index basket from the user's strategy.
 *
 * The model only names catalog addresses and weights. The basket reaches the
 * draft solely through this tool, after the same `resolveBasket` check vault
 * creation runs (allowed list, ERC-20, weights, a live quote), so the model can
 * neither invent a token nor hand the user a basket the vault cannot buy.
 */
@Injectable()
export class ProposeIndexBasketTool implements VaultAiTool {
  private readonly logger = new Logger(ProposeIndexBasketTool.name);

  readonly name = PROPOSE_INDEX_BASKET_TOOL;

  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: PROPOSE_INDEX_BASKET_TOOL,
      description:
        'Set the index basket (the tokens the vault buys when its acquire window locks, and their target ' +
        'weights) from the user strategy. Use only token addresses from the "Index basket catalog" in the ' +
        'system prompt. The server validates the basket and, on success, applies it to the draft; the user ' +
        'can still edit it afterwards.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['targets', 'reserveBps'],
        properties: {
          targets: {
            type: 'array',
            description:
              `1 to ${INDEX_MAX_ASSETS} catalog tokens. weightBps is the token's share of the invested ` +
              `capital in basis points: each at least ${INDEX_MIN_WEIGHT_BPS}, all together exactly 10000.`,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['assetAddress', 'weightBps'],
              properties: {
                assetAddress: { type: 'string', description: 'Token address copied from the catalog' },
                weightBps: { type: 'integer', description: 'Target weight in basis points (100 = 1%)' },
              },
            },
          },
          reserveBps: {
            type: ['integer', 'null'],
            description:
              `Share of the raise kept in the native currency instead of bought, in basis points (0 to ${MAX_RESERVE_BPS}). ` +
              'null keeps the current reserve (10% by default).',
          },
        },
      },
    },
  };

  constructor(private readonly indexVaultService: IndexVaultService) {}

  async execute(context: VaultAiToolContext, args: Record<string, unknown>): Promise<VaultAiToolOutcome> {
    if (context.spec.archetype !== VaultArchetype.index_weighted) {
      return { result: { ok: false, reason: 'not_an_index_vault' } };
    }

    const catalog = await this.indexVaultService.getSupportedAssets().catch(() => null);
    if (!catalog?.restricted || !catalog.assets.length) {
      return {
        result: {
          ok: false,
          reason: 'no_catalog',
          guidance:
            'There is no token catalog to choose from, so the user has to pick the basket. Offer "choose_basket".',
        },
      };
    }

    const rawTargets = Array.isArray(args.targets) ? args.targets : [];
    const targets = rawTargets.map(t => ({
      assetAddress: String((t as Record<string, unknown>)?.assetAddress ?? '').trim(),
      weightBps: Number((t as Record<string, unknown>)?.weightBps),
    }));

    // Checked here as well as in resolveBasket so the model gets back the exact
    // offending address and the list it should have picked from.
    const allowed = new Map<string, IndexSupportedAsset>(catalog.assets.map(a => [a.assetAddress.toLowerCase(), a]));
    const unknown = targets.filter(t => !allowed.has(t.assetAddress.toLowerCase())).map(t => t.assetAddress);
    if (unknown.length) {
      return {
        result: {
          ok: false,
          reason: 'not_in_catalog',
          unknown,
          guidance: 'Use only addresses from the catalog. Never invent or guess an address.',
        },
      };
    }

    const reserveBps = this.resolveReserve(args.reserveBps, context.draft);
    if (reserveBps === null) {
      return {
        result: { ok: false, reason: 'invalid_reserve', guidance: `reserveBps must be 0 to ${MAX_RESERVE_BPS}` },
      };
    }

    let resolved: Awaited<ReturnType<IndexVaultService['resolveBasket']>>;
    try {
      resolved = await this.indexVaultService.resolveBasket(
        targets.map(t => {
          const meta = allowed.get(t.assetAddress.toLowerCase())!;
          return { assetAddress: meta.assetAddress, weightBps: t.weightBps, symbol: meta.symbol, name: meta.name };
        })
      );
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      this.logger.log(`propose_index_basket rejected for user ${context.userId}: ${error.message}`);
      return {
        result: {
          ok: false,
          reason: 'invalid_basket',
          error: error.message,
          guidance: 'Fix the basket so it passes this check and call the tool again.',
        },
      };
    }

    return {
      result: {
        ok: true,
        basket: resolved.map(t => ({ symbol: t.symbol, name: t.name, weightPercent: t.weightBps / 100 })),
        reservePercent: reserveBps / 100,
        guidance:
          'The basket is applied to the draft. Tell the user in one or two sentences what you picked and why, ' +
          'by symbol and percent — never addresses. They can adjust it with "choose_basket".',
      },
      draftPatch: { indexBasket: { targets: resolved, reserveBps } },
    };
  }

  /** Model value, else the reserve already in the draft, else the default. Null when out of range. */
  private resolveReserve(raw: unknown, draft: Record<string, unknown>): number | null {
    const current = (draft.indexBasket as { reserveBps?: unknown } | undefined)?.reserveBps;
    const value = raw ?? current ?? DEFAULT_RESERVE_BPS;
    const bps = Number(value);
    return Number.isInteger(bps) && bps >= 0 && bps <= MAX_RESERVE_BPS ? bps : null;
  }
}
