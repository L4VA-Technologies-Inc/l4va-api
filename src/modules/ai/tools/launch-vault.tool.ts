import { Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';

import { validateVaultDraftForLaunch } from '../spec/validate-draft-for-launch';

import { VaultAiTool, VaultAiToolContext, VaultAiToolOutcome } from './vault-ai-tool.types';

export const LAUNCH_VAULT_TOOL = 'launch_vault';

/**
 * Asks to launch the vault the user is currently configuring.
 *
 * The model never launches anything: this validates the current draft server-side and, at best,
 * returns a confirmation action for the frontend to present. Creation itself still runs through the
 * normal vault-creation flow, which requires the user's wallet signature.
 */
@Injectable()
export class LaunchVaultTool implements VaultAiTool {
  private readonly logger = new Logger(LaunchVaultTool.name);

  readonly name = LAUNCH_VAULT_TOOL;

  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: LAUNCH_VAULT_TOOL,
      description:
        'Request to launch the vault the user is currently configuring. Call this when the user clearly ' +
        'expresses intent to create, launch, deploy or proceed with the vault. Do not call it for questions ' +
        'about launching, for hypotheticals, or when the user postpones or declines. The current vault ' +
        'configuration is read from server state — no arguments are needed. Calling this does not launch ' +
        'anything: it asks the server to validate the vault and show the user a launch confirmation.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  };

  async execute(context: VaultAiToolContext): Promise<VaultAiToolOutcome> {
    const validation = validateVaultDraftForLaunch(context.draft, context.spec);

    if (!validation.ok) {
      this.logger.log(
        `launch_vault rejected for user ${context.userId}: missing=[${validation.missingFields.join(', ')}] ` +
          `errors=[${validation.errors.join('; ')}]`
      );
      return {
        result: {
          ok: false,
          reason: 'validation_failed',
          missingFields: validation.missingFields,
          errors: validation.errors,
          guidance:
            'The vault cannot be launched yet. Tell the user exactly what is still missing or invalid and help ' +
            'them fill it in. Do not claim the vault was launched.',
        },
      };
    }

    return {
      result: {
        ok: true,
        status: 'awaiting_user_confirmation',
        guidance:
          'The vault passed validation and a launch confirmation is now shown to the user. Tell them to confirm ' +
          'it to sign and launch. Do not claim the vault has been created — it has not been yet.',
      },
      action: {
        type: 'confirmation',
        name: LAUNCH_VAULT_TOOL,
        label: 'Launch Vault',
        description: 'Review the configuration and confirm to sign and launch this vault.',
      },
    };
  }
}
