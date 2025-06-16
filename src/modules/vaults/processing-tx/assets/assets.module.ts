import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Asset } from 'src/database/asset.entity';
import { Transaction } from 'src/database/transaction.entity';
import { User } from 'src/database/user.entity';
import { Vault } from 'src/database/vault.entity';

import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

@Module({
  imports: [TypeOrmModule.forFeature([Asset, Vault, Transaction, User])],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
