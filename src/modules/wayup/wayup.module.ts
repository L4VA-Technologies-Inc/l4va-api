import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WayUpController } from './wayup.controller';
import { WayUpService } from './wayup.service';

import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { GoogleKMSService } from '@/modules/google_cloud/google-kms.service';
import { GoogleSecretService } from '@/modules/google_cloud/google-secret.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, VaultTreasuryWallet]), HttpModule],
  controllers: [WayUpController],
  providers: [WayUpService, BlockchainService, TreasuryWalletService, GoogleKMSService, GoogleSecretService],
  exports: [WayUpService],
})
export class WayUpModule {}
