import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DexHunterController } from './dexhunter.controller';
import { DexHunterService } from './dexhunter.service';

import { VaultTreasuryWallet } from '@/database/vault-treasury-wallet.entity';
import { Vault } from '@/database/vault.entity';
import { GoogleKMSService } from '@/modules/google/google-kms.service';
import { GoogleSecretService } from '@/modules/google/google-secret.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, VaultTreasuryWallet]), HttpModule],
  controllers: [DexHunterController],
  providers: [DexHunterService, BlockchainService, TreasuryWalletService, GoogleKMSService, GoogleSecretService],
  exports: [DexHunterService],
})
export class DexHunterModule {}
