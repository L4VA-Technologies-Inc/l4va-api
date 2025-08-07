import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';

import { VyfiController } from './vyfi.controller';
import { VyfiService } from './vyfi.service';

@Module({
  imports: [HttpModule, ConfigModule, BlockchainModule],
  controllers: [VyfiController],
  providers: [VyfiService],
  exports: [VyfiService],
})
export class VyfiModule {}
