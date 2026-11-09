import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OpenAiClient } from './openai.client';
import { TickerAvailabilityService } from './ticker-availability.service';
import { LaunchVaultTool } from './tools/launch-vault.tool';
import { RewardsInfoTool } from './tools/rewards-info.tool';
import { VaultAiToolRegistry } from './tools/vault-ai-tool.registry';
import { VAULT_AI_TOOLS, VaultAiTool } from './tools/vault-ai-tool.types';
import { VaultAssistantController } from './vault-assistant.controller';
import { VaultAssistantService } from './vault-assistant.service';

import { Vault } from '@/database/vault.entity';
import { GoogleCloudStorageModule } from '@/modules/google_cloud/google_bucket/bucket.module';
import { PresetsModule } from '@/modules/presets/presets.module';
import { IndexVaultModule } from '@/modules/vaults/index-vault/index-vault.module';

@Module({
  imports: [PresetsModule, GoogleCloudStorageModule, IndexVaultModule, TypeOrmModule.forFeature([Vault])],
  controllers: [VaultAssistantController],
  providers: [
    OpenAiClient,
    TickerAvailabilityService,
    LaunchVaultTool,
    RewardsInfoTool,
    {
      // The single place where a new assistant capability is registered.
      provide: VAULT_AI_TOOLS,
      useFactory: (launchVault: LaunchVaultTool, rewardsInfo: RewardsInfoTool): VaultAiTool[] => [
        launchVault,
        rewardsInfo,
      ],
      inject: [LaunchVaultTool, RewardsInfoTool],
    },
    VaultAiToolRegistry,
    VaultAssistantService,
  ],
})
export class AiModule {}
