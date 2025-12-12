import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PresetsController } from './presets.controller';
import { PresetsService } from './presets.service';

import { User } from '@/database/user.entity';
import { VaultPreset } from '@/database/vaultPreset.entity';

@Module({
  imports: [TypeOrmModule.forFeature([VaultPreset, User])],
  controllers: [PresetsController],
  providers: [PresetsService],
  exports: [PresetsService],
})
export class PresetsModule {}
