import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { FaucetController } from './faucet.controller';
import { FaucetService } from './faucet.service';

import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [ConfigModule, BlockchainModule],
  controllers: [FaucetController],
  providers: [FaucetService],
})
export class FaucetModule {}
