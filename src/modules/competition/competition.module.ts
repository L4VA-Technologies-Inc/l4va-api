import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompetitionController } from './competition.controller';
import { CompetitionService } from './competition.service';

import { CompetitionEntry, CompetitionSeason, CompetitionSnapshot } from '@/database/competition.entity';
import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { PriceModule } from '@/modules/price/price.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CompetitionSeason, CompetitionEntry, CompetitionSnapshot, Vault, Market]),
    PriceModule,
    BlockchainModule,
  ],
  controllers: [CompetitionController],
  providers: [CompetitionService],
})
export class CompetitionModule {}
