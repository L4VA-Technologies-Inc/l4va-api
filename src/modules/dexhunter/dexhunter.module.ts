import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GoogleKMSService } from '../google_cloud/google-kms.service';
import { GoogleSecretService } from '../google_cloud/google-secret.service';

import { DexHunterController } from './dexhunter.controller';
import { DexHunterService } from './dexhunter.service';

import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, VaultTreasuryWallet]), HttpModule],
  controllers: [DexHunterController],
  providers: [DexHunterService, BlockchainService, TreasuryWalletService, GoogleKMSService, GoogleSecretService],
  exports: [DexHunterService],
})
export class DexHunterModule {}
