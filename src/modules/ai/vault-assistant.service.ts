import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { GenerateVaultImageRes } from './dto/generate-vault-image.dto';
import { VaultAssistantMessageReq } from './dto/vault-assistant-message.req';
import { VaultAssistantMessageRes } from './dto/vault-assistant-message.res';
import { OpenAiClient } from './openai.client';
import { buildVaultAssistantPrompt, PresetContext } from './prompts/vault-assistant.prompt';
import { resolveVaultCreationSpec } from './spec/resolve-spec';
import { sanitizeVaultDraft } from './spec/sanitize-draft';
import { SpecChain } from './spec/spec.types';
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

@Injectable()
export class VaultAssistantService {
  private readonly logger = new Logger(VaultAssistantService.name);

  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly presetsService: PresetsService,
    private readonly storageService: GoogleCloudStorageService
  ) {}

  async respond(userId: string, request: VaultAssistantMessageReq): Promise<VaultAssistantMessageRes> {
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

    let completion: AssistantCompletion;
    try {
      completion = (await this.openAiClient.createStructuredCompletion({
        systemPrompt,
        messages: request.messages.map(message => ({ role: message.role, content: message.content })),
        schemaName: 'vault_assistant_turn',
        schema: buildVaultDraftJsonSchema(spec, { presetIds: presetContext.map(preset => preset.id) }),
      })) as AssistantCompletion;
    } catch (error) {
      this.logger.error(`Vault assistant completion failed: ${(error as Error).message}`);
      throw new BadRequestException('The assistant could not answer right now. Please try again.');
    }

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
}
