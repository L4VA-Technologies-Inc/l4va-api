import { Module } from '@nestjs/common';

import { OpenAiClient } from './openai.client';
import { LaunchVaultTool } from './tools/launch-vault.tool';
import { VaultAiToolRegistry } from './tools/vault-ai-tool.registry';
import { VAULT_AI_TOOLS, VaultAiTool } from './tools/vault-ai-tool.types';
import { VaultAssistantController } from './vault-assistant.controller';
import { VaultAssistantService } from './vault-assistant.service';

import { GoogleCloudStorageModule } from '@/modules/google_cloud/google_bucket/bucket.module';
import { PresetsModule } from '@/modules/presets/presets.module';

@Module({
  imports: [PresetsModule, GoogleCloudStorageModule],
  controllers: [VaultAssistantController],
  providers: [
    OpenAiClient,
    LaunchVaultTool,
    {
      // The single place where a new assistant capability is registered.
      provide: VAULT_AI_TOOLS,
      useFactory: (launchVault: LaunchVaultTool): VaultAiTool[] => [launchVault],
      inject: [LaunchVaultTool],
    },
    VaultAiToolRegistry,
    VaultAssistantService,
  ],
})
export class AiModule {}
