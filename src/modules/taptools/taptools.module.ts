import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TaptoolsController } from './taptools.controller';
import { TaptoolsService } from './taptools.service';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, User]), AssetsModule, AlertsModule],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
