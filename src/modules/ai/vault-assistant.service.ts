import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { GenerateVaultImageRes } from './dto/generate-vault-image.dto';
import { VaultAssistantMessageReq } from './dto/vault-assistant-message.req';
import { VaultAssistantMessageRes } from './dto/vault-assistant-message.res';
import { extractPartialJsonString } from './extract-partial-json-string';
import { OpenAiClient } from './openai.client';
import { buildVaultAssistantPrompt, PresetContext } from './prompts/vault-assistant.prompt';
import { resolveVaultCreationSpec } from './spec/resolve-spec';
import { sanitizeVaultDraft } from './spec/sanitize-draft';
import { ResolvedVaultCreationSpec, SpecChain } from './spec/spec.types';
import { buildVaultDraftJsonSchema } from './spec/vault-draft.schema';

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
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: Record<string, unknown>;
}

export type VaultAssistantStreamEvent =
  | { type: 'delta'; text: string }
  | ({ type: 'done' } & VaultAssistantMessageRes)
  | { type: 'error'; message: string };

@Injectable()
export class VaultAssistantService {
  private readonly logger = new Logger(VaultAssistantService.name);

  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly presetsService: PresetsService,
    private readonly storageService: GoogleCloudStorageService
  ) {}

  async respond(userId: string, request: VaultAssistantMessageReq): Promise<VaultAssistantMessageRes> {
    const context = await this.buildTurnContext(userId, request);

    let completion: AssistantCompletion;
    try {
      completion = (await this.openAiClient.createStructuredCompletion({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        schemaName: 'vault_assistant_turn',
        schema: context.schema,
      })) as AssistantCompletion;
    } catch (error) {
      this.logger.error(`Vault assistant completion failed: ${(error as Error).message}`);
      throw new BadRequestException('The assistant could not answer right now. Please try again.');
    }

    return this.toResponse(completion, context.spec);
  }

  async *respondStream(userId: string, request: VaultAssistantMessageReq): AsyncGenerator<VaultAssistantStreamEvent> {
    const context = await this.buildTurnContext(userId, request);

    let raw = '';
    let streamedMessage = '';

    try {
      for await (const delta of this.openAiClient.createStructuredCompletionStream({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        schemaName: 'vault_assistant_turn',
        schema: context.schema,
      })) {
        raw += delta;
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

    let completion: AssistantCompletion;
    try {
      completion = JSON.parse(raw) as AssistantCompletion;
    } catch (error) {
      this.logger.error(`Vault assistant stream parse failed: ${(error as Error).message}`);
      yield { type: 'error', message: 'The assistant could not answer right now. Please try again.' };
      return;
    }

    const response = this.toResponse(completion, context.spec);
    if (response.message.startsWith(streamedMessage) && response.message.length > streamedMessage.length) {
      yield { type: 'delta', text: response.message.slice(streamedMessage.length) };
    } else if (streamedMessage.length === 0 && response.message) {
      yield { type: 'delta', text: response.message };
    }

    yield { type: 'done', ...response };
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
      systemPrompt,
      messages: request.messages.map(message => ({ role: message.role, content: message.content })),
      schema: buildVaultDraftJsonSchema(spec, { presetIds: presetContext.map(preset => preset.id) }),
    };
  }

  private toResponse(completion: AssistantCompletion, spec: ResolvedVaultCreationSpec): VaultAssistantMessageRes {
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
    };
  }
}
