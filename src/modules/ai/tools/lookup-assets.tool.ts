import { Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';

import { ResolvedVaultAsset, VaultAiTool, VaultAiToolContext, VaultAiToolOutcome } from './vault-ai-tool.types';

import { TokensService } from '@/modules/tokens/tokens.service';
import { ChainType } from '@/types/vault.types';

export const LOOKUP_ASSETS_TOOL = 'lookup_assets';

const MAX_QUERIES = 10;
const MAX_TOTAL_ASSETS = 10;

/**
 * Resolves named tickers / collections against the Robinhood catalog so they can be dropped
 * into the vault whitelist. The model never invents contract addresses — only this tool's
 * matches are applied to the draft.
 */
@Injectable()
export class LookupAssetsTool implements VaultAiTool {
  private readonly logger = new Logger(LookupAssetsTool.name);

  readonly name = LOOKUP_ASSETS_TOOL;

  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: LOOKUP_ASSETS_TOOL,
      description:
        'Look up real assets on the active chain by ticker, symbol, name, or contract address. ' +
        'Call this in the same turn the user names assets they want in the vault, or when you need ' +
        'a small starter basket for a recommended vault type (RWA-backed memecoin, community ETF, ' +
        'NFT basket). Never invent identifiers — only assets this tool returns are added. Do not ' +
        'offer choose_assets for queries that matched.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            description: 'Tickers, names, or contract addresses to look up, e.g. ["NVDA", "SPY"].',
            items: { type: 'string' },
          },
        },
        required: ['queries'],
        additionalProperties: false,
      },
    },
  };

  constructor(private readonly tokensService: TokensService) {}

  async execute(context: VaultAiToolContext, args: Record<string, unknown>): Promise<VaultAiToolOutcome> {
    if (context.chain !== ChainType.robinhood) {
      return {
        result: {
          ok: false,
          reason: 'unsupported_chain',
          guidance:
            'Ticker lookup is only available on Robinhood Chain. Offer the choose_assets option so the ' +
            'user can pick collections themselves. Do not invent policy IDs.',
        },
      };
    }

    const queries = Array.isArray(args.queries)
      ? args.queries.filter((item): item is string => typeof item === 'string').slice(0, MAX_QUERIES)
      : [];

    if (!queries.length) {
      return {
        result: {
          ok: false,
          reason: 'missing_queries',
          guidance: 'Pass at least one ticker, name, or address in "queries".',
        },
      };
    }

    const hits = this.tokensService.searchRobinhoodCatalog(queries);
    const resolved: ResolvedVaultAsset[] = [];
    const unmatched: string[] = [];

    for (const hit of hits) {
      if (!hit.matches.length) {
        unmatched.push(hit.query);
        continue;
      }
      for (const match of hit.matches) {
        if (resolved.length >= MAX_TOTAL_ASSETS) break;
        if (resolved.some(asset => asset.policyId === match.policyId)) continue;
        resolved.push(match);
      }
    }

    this.logger.log(
      `lookup_assets for user ${context.userId}: ${resolved.length} matched, ${unmatched.length} unmatched`
    );

    return {
      result: {
        ok: resolved.length > 0,
        matched: resolved.map(asset => ({
          ticker: asset.symbol || asset.name,
          name: asset.name,
          assetClass: asset.assetClass,
        })),
        unmatched,
        guidance:
          resolved.length > 0
            ? 'These assets have been added to the vault whitelist. Name them in your reply. ' +
              'Do not offer choose_assets for matched tickers. ' +
              (unmatched.length
                ? `These did not match and still need choose_assets: ${unmatched.join(', ')}.`
                : 'Do not offer choose_assets unless the user wants to add more.')
            : 'No catalog matches. Offer choose_assets so the user can pick collections themselves. ' +
              'Do not invent contract addresses.',
      },
      resolvedAssets: resolved,
    };
  }
}
