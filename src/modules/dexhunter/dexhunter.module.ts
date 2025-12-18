import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssetsModule } from '../vaults/assets/assets.module';
import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '../vaults/treasure/treasure-wallet.module';

import { DexHunterController } from './dexhunter.controller';
import { DexHunterService } from './dexhunter.service';

import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, VaultTreasuryWallet]),
    AssetsModule,
    BlockchainModule,
    TreasureWalletModule,
    HttpModule,
  ],
  controllers: [DexHunterController],
  providers: [DexHunterService],
  exports: [DexHunterService],
})
export class DexHunterModule {}
