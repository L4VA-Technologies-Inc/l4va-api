import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemSettingsService } from './system-settings.service';

import { SystemSettings } from '@/database/systemSettings.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemSettings])],
  providers: [SystemSettingsService],
  exports: [SystemSettingsService],
})
export class SystemSettingsModule {}
