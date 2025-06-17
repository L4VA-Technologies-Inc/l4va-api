import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Asset } from '@/database/asset.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionsModule } from '../../processing-tx/offchain-tx/transactions.module';

import { AcquireController } from './acquire.controller';
import { AcquireService } from './acquire.service';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, User, Asset]), TransactionsModule],
  controllers: [AcquireController],
  providers: [AcquireService],
  exports: [AcquireService],
})
export class AcquireModule {}
