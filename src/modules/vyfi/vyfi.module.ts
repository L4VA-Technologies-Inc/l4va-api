import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';

import { VyfiService } from './vyfi.service';

import { Claim } from '@/database/claim.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Claim]), HttpModule, ConfigModule, BlockchainModule],
  providers: [VyfiService],
  exports: [VyfiService],
})
export class VyfiModule {}
