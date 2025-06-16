import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Asset } from 'src/database/asset.entity';
import { Vault } from 'src/database/vault.entity';

import { TaptoolsController } from './taptools.controller';
import { TaptoolsService } from './taptools.service';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, Asset])],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
