import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '../../database/asset.entity';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';
import { Vault } from '../../database/vault.entity';
import {Transaction} from '../../database/transaction.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Asset, Vault, Transaction])
  ],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService]
})
export class AssetsModule {}
