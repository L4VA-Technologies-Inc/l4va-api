import { Module } from '@nestjs/common';

import { OpenAiClient } from './openai.client';
import { VaultAssistantController } from './vault-assistant.controller';
import { VaultAssistantService } from './vault-assistant.service';

import { GoogleCloudStorageModule } from '@/modules/google_cloud/google_bucket/bucket.module';
import { PresetsModule } from '@/modules/presets/presets.module';

@Module({
  imports: [PresetsModule, GoogleCloudStorageModule],
  controllers: [VaultAssistantController],
  providers: [OpenAiClient, VaultAssistantService],
})
export class AiModule {}
