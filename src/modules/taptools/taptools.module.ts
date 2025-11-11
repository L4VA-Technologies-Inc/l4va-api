import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TaptoolsController } from './taptools.controller';
import { TaptoolsService } from './taptools.service';

import { Vault } from '@/database/vault.entity';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault]), AssetsModule],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
