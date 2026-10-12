import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { GenerateVaultImageRes } from './dto/generate-vault-image.dto';
import { VaultAssistantAction } from './dto/vault-assistant-action';
import { VaultAssistantMessageReq } from './dto/vault-assistant-message.req';
import { VaultAssistantMessageRes } from './dto/vault-assistant-message.res';
import { VaultAssistantOption } from './dto/vault-assistant-option';
import { extractPartialJsonString } from './extract-partial-json-string';
import { ChatMessage, ChatTurn, ChatTurnParams, OpenAiClient } from './openai.client';
import { buildVaultAssistantPrompt, IndexCatalogEntry, PresetContext } from './prompts/vault-assistant.prompt';
import { buildVaultCompletionContext } from './spec/completion-context';
import { resolveVaultCreationSpec } from './spec/resolve-spec';
import { sanitizeVaultDraft } from './spec/sanitize-draft';
import { ResolvedVaultCreationSpec, SpecChain, SpecNetwork } from './spec/spec.types';
import { buildVaultDraftJsonSchema } from './spec/vault-draft.schema';
import { PROPOSE_INDEX_BASKET_TOOL } from './tools/propose-index-basket.tool';
import { VaultAiToolRegistry } from './tools/vault-ai-tool.registry';
import { VaultAiToolContext } from './tools/vault-ai-tool.types';

import { SystemSettingsService } from '@/modules/globals/system-settings';
import { GoogleCloudStorageService } from '@/modules/google_cloud/google_bucket/bucket.service';
import { PresetsService } from '@/modules/presets/presets.service';
import { IndexVaultService } from '@/modules/vaults/index-vault/index-vault.service';
import { VaultArchetype } from '@/types/index-vault.types';

interface AssistantCompletion {
  message?: unknown;
  status?: unknown;
  missingFields?: unknown;
  options?: unknown;
  vaultDraft?: unknown;
  resetDraft?: unknown;
}

/** What tool calls produced this turn, carried into the response. */
interface ToolRoundOutcome {
  action?: VaultAssistantAction;
  draftPatch: Record<string, unknown>;
}

interface AssistantTurnContext {
  spec: ResolvedVaultCreationSpec;
  /**
   * Tool the first round must call. Set while an index vault has no basket and
   * a catalog exists: left to choose, the model tends to answer in text and
   * describe tokens itself instead of having the server validate a basket.
   */
  forcedFirstTool?: string;
  messages: ChatMessage[];
  schema: Record<string, unknown>;
  toolContext: VaultAiToolContext;
}

export type VaultAssistantStreamEvent =
  | { type: 'delta'; text: string }
  | ({ type: 'done' } & VaultAssistantMessageRes)
  | { type: 'error'; message: string };

const SCHEMA_NAME = 'vault_assistant_turn';

/**
 * Guards against a model that keeps requesting tools instead of answering. The last allowed round
 * runs with `tool_choice: 'none'`, so a turn always ends with a user-facing message.
 */
const MAX_TOOL_ROUNDS = 3;

/** Enough for a real choice, few enough that the chat never turns into a menu. */
const MAX_OPTIONS = 3;
const MAX_OPTION_LABEL_LENGTH = 40;
const MAX_OPTION_VALUE_LENGTH = 200;

/** Quick replies are model-authored text that becomes a button, so they are length-capped here. */
function sanitizeOptions(raw: unknown): VaultAssistantOption[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const { label, value } = item as Record<string, unknown>;
      if (typeof label !== 'string' || typeof value !== 'string') return [];

      const trimmedLabel = label.trim().slice(0, MAX_OPTION_LABEL_LENGTH);
      const trimmedValue = value.trim().slice(0, MAX_OPTION_VALUE_LENGTH);
      return trimmedLabel && trimmedValue ? [{ label: trimmedLabel, value: trimmedValue }] : [];
    })
    .slice(0, MAX_OPTIONS);
}

@Injectable()
export class VaultAssistantService {
  private readonly logger = new Logger(VaultAssistantService.name);

  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly presetsService: PresetsService,
    private readonly storageService: GoogleCloudStorageService,
    private readonly toolRegistry: VaultAiToolRegistry,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly indexVaultService: IndexVaultService
  ) {}

  async respond(userId: string, request: VaultAssistantMessageReq): Promise<VaultAssistantMessageRes> {
    const context = await this.buildTurnContext(userId, request);
    const messages = [...context.messages];
    const tools: ToolRoundOutcome = { draftPatch: {} };

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const isLastRound = round === MAX_TOOL_ROUNDS - 1;
        const turn = await this.openAiClient.createChatTurn(this.turnParams(context, messages, round, isLastRound));

        if (turn.toolCalls.length && !isLastRound) {
          await this.runToolRound(context, messages, turn, tools);
          continue;
        }

        return this.toResponse(this.parseCompletion(turn.content), context.spec, tools);
      }
    } catch (error) {
      this.logger.error(`Vault assistant completion failed: ${(error as Error).message}`);
      throw new BadRequestException('The assistant could not answer right now. Please try again.');
    }

    // Unreachable: the last round cannot request tools. Kept so the method is total.
    throw new BadRequestException('The assistant could not answer right now. Please try again.');
  }

  async *respondStream(userId: string, request: VaultAssistantMessageReq): AsyncGenerator<VaultAssistantStreamEvent> {
    const context = await this.buildTurnContext(userId, request);
    const messages = [...context.messages];
    const tools: ToolRoundOutcome = { draftPatch: {} };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const isLastRound = round === MAX_TOOL_ROUNDS - 1;

      let turn: ChatTurn | null = null;
      let raw = '';
      let streamedMessage = '';
      let toolCallSeen = false;

      try {
        for await (const event of this.openAiClient.streamChatTurn(
          this.turnParams(context, messages, round, isLastRound)
        )) {
          if (event.type === 'turn') {
            turn = event.turn;
            continue;
          }
          if (event.type === 'tool_call_started') {
            toolCallSeen = true;
            continue;
          }

          raw += event.delta;
          // Once the model has committed to a tool call, its content is not the user-facing turn —
          // withholding it keeps partial structured JSON out of the chat.
          if (toolCallSeen && !streamedMessage) continue;

          const extracted = extractPartialJsonString(raw, 'message');
          if (extracted !== null && extracted.length > streamedMessage.length) {
            const text = extracted.slice(streamedMessage.length);
            streamedMessage = extracted;
            yield { type: 'delta', text };
          }
        }
      } catch (error) {
        this.logger.error(`Vault assistant stream failed: ${(error as Error).message}`);
        yield { type: 'error', message: 'The assistant could not answer right now. Please try again.' };
        return;
      }

      if (!turn) {
        this.logger.error('Vault assistant stream ended without a completed turn');
        yield { type: 'error', message: 'The assistant could not answer right now. Please try again.' };
        return;
      }

      if (turn.toolCalls.length && !isLastRound) {
        if (streamedMessage) {
          // The model streamed a reply *and* asked for a tool. Text already reached the user, so the
          // streamed reply wins and the tool request is dropped rather than shown twice.
          this.logger.warn(
            `Ignoring tool call(s) [${turn.toolCalls.map(call => call.name).join(', ')}] that arrived after streamed content`
          );
        } else {
          try {
            await this.runToolRound(context, messages, turn, tools);
          } catch (error) {
            this.logger.error(`Vault assistant tool round failed: ${(error as Error).message}`);
            yield { type: 'error', message: 'The assistant could not answer right now. Please try again.' };
            return;
          }
          continue;
        }
      }

      let completion: AssistantCompletion;
      try {
        completion = this.parseCompletion(raw || turn.content);
      } catch (error) {
        this.logger.error(`Vault assistant stream parse failed: ${(error as Error).message}`);
        yield { type: 'error', message: 'The assistant could not answer right now. Please try again.' };
        return;
      }

      const response = this.toResponse(completion, context.spec, tools);
      if (response.message.startsWith(streamedMessage) && response.message.length > streamedMessage.length) {
        yield { type: 'delta', text: response.message.slice(streamedMessage.length) };
      } else if (!streamedMessage && response.message) {
        yield { type: 'delta', text: response.message };
      }

      yield { type: 'done', ...response };
      return;
    }
  }

  async generateImage(prompt: string): Promise<GenerateVaultImageRes> {
    let image: Buffer;
    try {
      image = await this.openAiClient.generateImage(prompt);
    } catch (error) {
      const message = (error as Error).message ?? '';
      this.logger.warn(`Vault image generation failed: ${message}`);
      if (/safety|policy|moderation|rejected/i.test(message)) {
        throw new BadRequestException('That prompt was rejected by the image model. Try describing it differently.');
      }
      throw new BadRequestException('Image generation failed. Please try again.');
    }

    const file = await this.storageService.uploadGeneratedImage(image);
    return { fileUrl: file.file_url };
  }

  private turnParams(
    context: AssistantTurnContext,
    messages: ChatMessage[],
    round: number,
    isLastRound: boolean
  ): ChatTurnParams {
    const forced = round === 0 && !isLastRound && context.forcedFirstTool;
    return {
      messages,
      jsonSchema: { name: SCHEMA_NAME, schema: context.schema },
      tools: this.toolRegistry.definitions,
      toolChoice: forced ? { name: context.forcedFirstTool! } : isLastRound ? 'none' : 'auto',
    };
  }

  /**
   * Executes every tool the model requested, appends the results to `messages` so the next round can
   * see them, and records any UI action and validated draft values the tools produced in `outcome`.
   */
  private async runToolRound(
    context: AssistantTurnContext,
    messages: ChatMessage[],
    turn: ChatTurn,
    outcome: ToolRoundOutcome
  ): Promise<void> {
    messages.push({
      role: 'assistant',
      content: turn.content,
      tool_calls: turn.toolCalls.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of turn.toolCalls) {
      const result = await this.toolRegistry.execute(call.name, context.toolContext, call.arguments);
      if (result.action) {
        outcome.action = result.action;
      }
      if (result.draftPatch) {
        Object.assign(outcome.draftPatch, result.draftPatch);
        // A later tool this turn (launch_vault) must validate the draft the user will actually get.
        context.toolContext.draft = { ...context.toolContext.draft, ...result.draftPatch };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.result) });
    }
  }

  private parseCompletion(content: string | null): AssistantCompletion {
    if (!content) {
      throw new Error('AI response was empty');
    }
    return JSON.parse(content) as AssistantCompletion;
  }

  private async buildTurnContext(userId: string, request: VaultAssistantMessageReq): Promise<AssistantTurnContext> {
    // The assistant does not pick a vault type: it builds the one the chain
    // currently offers. Robinhood is index-only until RWA and NFT vaults land,
    // and that is operational config, not a constant.
    const chain = request.chain as SpecChain;
    const [archetype = VaultArchetype.standard] = this.systemSettingsService.vaultArchetypesEnabled(chain);
    const spec = resolveVaultCreationSpec(chain, request.network, archetype);

    const presets = await this.presetsService.getAllPresets(userId);
    const presetContext: PresetContext[] = presets.map(preset => ({
      id: preset.id,
      name: preset.name,
      type: preset.type,
      config: preset.config,
    }));

    // Re-sanitize the client-supplied draft so a tampered payload cannot smuggle
    // arbitrary content into the prompt.
    const { draft: currentDraft } = sanitizeVaultDraft(request.currentDraft ?? {}, spec);

    const indexCatalog = archetype === VaultArchetype.index_weighted ? await this.loadIndexCatalog() : [];

    const systemPrompt = buildVaultAssistantPrompt({
      spec,
      presets: presetContext,
      indexCatalog,
      currentDraft,
      // Computed from the untouched client draft: the assistant has to know about the image and the
      // collections it cannot set itself, which the sanitized draft above deliberately drops.
      completion: buildVaultCompletionContext(request.currentDraft ?? {}, spec),
      validationErrors: request.validationErrors,
    });

    const basketTargets = (request.currentDraft?.indexBasket as { targets?: unknown[] } | undefined)?.targets;
    const needsBasket = indexCatalog.length > 0 && !(Array.isArray(basketTargets) && basketTargets.length > 0);

    return {
      spec,
      forcedFirstTool: needsBasket ? PROPOSE_INDEX_BASKET_TOOL : undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        ...request.messages.map(message => ({ role: message.role, content: message.content })),
      ],
      schema: buildVaultDraftJsonSchema(spec, { presetIds: presetContext.map(preset => preset.id) }),
      toolContext: {
        userId,
        chain: request.chain as SpecChain,
        network: request.network as SpecNetwork,
        // Tools validate the *whole* client draft, including fields the assistant may not set
        // (images, whitelists), which is why this is the raw payload rather than `currentDraft`.
        draft: request.currentDraft ?? {},
        spec,
      },
    };
  }

  /** Tokens the assistant may put in an index basket. Empty (user picks) when unrestricted or unreadable. */
  private async loadIndexCatalog(): Promise<IndexCatalogEntry[]> {
    try {
      const supported = await this.indexVaultService.getSupportedAssets();
      return supported.restricted
        ? supported.assets.map(a => ({ assetAddress: a.assetAddress, symbol: a.symbol, name: a.name }))
        : [];
    } catch (error) {
      this.logger.warn(`Index basket catalog unavailable: ${(error as Error).message}`);
      return [];
    }
  }

  private toResponse(
    completion: AssistantCompletion,
    spec: ResolvedVaultCreationSpec,
    tools: ToolRoundOutcome
  ): VaultAssistantMessageRes {
    const sanitized = sanitizeVaultDraft(completion.vaultDraft, spec);
    const { rejected } = sanitized;
    // Tool patches were validated server-side; they are merged after sanitizing because they
    // carry fields the model is not allowed to write itself.
    const draft = { ...sanitized.draft, ...tools.draftPatch };
    if (rejected.length) {
      this.logger.warn(`Vault assistant produced rejected values: ${rejected.join('; ')}`);
    }

    const missingFields = Array.isArray(completion.missingFields)
      ? completion.missingFields.filter((field): field is string => typeof field === 'string')
      : [];

    return {
      message: typeof completion.message === 'string' ? completion.message : '',
      // A rejected value means the draft is not complete, whatever the model claims.
      status: completion.status === 'ready' && !rejected.length ? 'ready' : 'gathering',
      vaultDraft: draft,
      resetDraft: completion.resetDraft === true,
      missingFields,
      options: sanitizeOptions(completion.options),
      rejected,
      specVersion: spec.version,
      // An action only exists because a tool produced it after server-side validation — the model
      // cannot put one here by claiming the vault is ready.
      action: tools.action ?? null,
    };
  }
}
