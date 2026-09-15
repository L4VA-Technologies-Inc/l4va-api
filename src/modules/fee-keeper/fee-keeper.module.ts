import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';

import { FeeKeeperService } from './fee-keeper.service';

import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault]), BlockchainModule, AlertsModule],
  providers: [FeeKeeperService],
  exports: [FeeKeeperService],
})
export class FeeKeeperModule {}
