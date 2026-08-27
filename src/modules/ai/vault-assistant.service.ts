import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { GenerateVaultImageRes } from './dto/generate-vault-image.dto';
import { VaultAssistantAction } from './dto/vault-assistant-action';
import { VaultAssistantMessageReq } from './dto/vault-assistant-message.req';
import { VaultAssistantMessageRes } from './dto/vault-assistant-message.res';
import { extractPartialJsonString } from './extract-partial-json-string';
import { ChatMessage, ChatTurn, ChatTurnParams, OpenAiClient } from './openai.client';
import { buildVaultAssistantPrompt, PresetContext } from './prompts/vault-assistant.prompt';
import { resolveVaultCreationSpec } from './spec/resolve-spec';
import { sanitizeVaultDraft } from './spec/sanitize-draft';
import { ResolvedVaultCreationSpec, SpecChain, SpecNetwork } from './spec/spec.types';
import { buildVaultDraftJsonSchema } from './spec/vault-draft.schema';
import { VaultAiToolRegistry } from './tools/vault-ai-tool.registry';
import { VaultAiToolContext } from './tools/vault-ai-tool.types';

import { GoogleCloudStorageService } from '@/modules/google_cloud/google_bucket/bucket.service';
import { PresetsService } from '@/modules/presets/presets.service';

interface AssistantCompletion {
  message?: unknown;
  status?: unknown;
  missingFields?: unknown;
  vaultDraft?: unknown;
  resetDraft?: unknown;
}

interface AssistantTurnContext {
  spec: ResolvedVaultCreationSpec;
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

@Injectable()
export class VaultAssistantService {
  private readonly logger = new Logger(VaultAssistantService.name);

  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly presetsService: PresetsService,
    private readonly storageService: GoogleCloudStorageService,
    private readonly toolRegistry: VaultAiToolRegistry
  ) {}

  async respond(userId: string, request: VaultAssistantMessageReq): Promise<VaultAssistantMessageRes> {
    const context = await this.buildTurnContext(userId, request);
    const messages = [...context.messages];
    let action: VaultAssistantAction | undefined;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const isLastRound = round === MAX_TOOL_ROUNDS - 1;
        const turn = await this.openAiClient.createChatTurn(this.turnParams(context, messages, isLastRound));

        if (turn.toolCalls.length && !isLastRound) {
          action = (await this.runToolRound(context, messages, turn)) ?? action;
          continue;
        }

        return this.toResponse(this.parseCompletion(turn.content), context.spec, action);
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
    let action: VaultAssistantAction | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const isLastRound = round === MAX_TOOL_ROUNDS - 1;

      let turn: ChatTurn | null = null;
      let raw = '';
      let streamedMessage = '';
      let toolCallSeen = false;

      try {
        for await (const event of this.openAiClient.streamChatTurn(this.turnParams(context, messages, isLastRound))) {
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
            action = (await this.runToolRound(context, messages, turn)) ?? action;
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

      const response = this.toResponse(completion, context.spec, action);
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

  private turnParams(context: AssistantTurnContext, messages: ChatMessage[], isLastRound: boolean): ChatTurnParams {
    return {
      messages,
      jsonSchema: { name: SCHEMA_NAME, schema: context.schema },
      tools: this.toolRegistry.definitions,
      toolChoice: isLastRound ? 'none' : 'auto',
    };
  }

  /**
   * Executes every tool the model requested, appends the results to `messages` so the next round can
   * see them, and returns the UI action a tool produced (if any).
   */
  private async runToolRound(
    context: AssistantTurnContext,
    messages: ChatMessage[],
    turn: ChatTurn
  ): Promise<VaultAssistantAction | undefined> {
    messages.push({
      role: 'assistant',
      content: turn.content,
      tool_calls: turn.toolCalls.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    let action: VaultAssistantAction | undefined;
    for (const call of turn.toolCalls) {
      const outcome = await this.toolRegistry.execute(call.name, context.toolContext, call.arguments);
      if (outcome.action) {
        action = outcome.action;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) });
    }

    return action;
  }

  private parseCompletion(content: string | null): AssistantCompletion {
    if (!content) {
      throw new Error('AI response was empty');
    }
    return JSON.parse(content) as AssistantCompletion;
  }

  private async buildTurnContext(userId: string, request: VaultAssistantMessageReq): Promise<AssistantTurnContext> {
    const spec = resolveVaultCreationSpec(request.chain as SpecChain, request.network);

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

    const systemPrompt = buildVaultAssistantPrompt({
      spec,
      presets: presetContext,
      currentDraft,
      validationErrors: request.validationErrors,
    });

    return {
      spec,
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

  private toResponse(
    completion: AssistantCompletion,
    spec: ResolvedVaultCreationSpec,
    action?: VaultAssistantAction
  ): VaultAssistantMessageRes {
    const { draft, rejected } = sanitizeVaultDraft(completion.vaultDraft, spec);
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
      rejected,
      specVersion: spec.version,
      // An action only exists because a tool produced it after server-side validation — the model
      // cannot put one here by claiming the vault is ready.
      action: action ?? null,
    };
  }
}
