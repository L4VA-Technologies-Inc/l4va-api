import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributionModule } from '../distribution/distribution.module';
import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';

/**
 * Diagnostic Module
 *
 * Provides endpoints for diagnosing and manually controlling vault distribution.
 * For admin/recovery use only.
 */
@Module({
  imports: [DistributionModule, BlockchainModule, TypeOrmModule.forFeature([Vault, Claim, Transaction])],
})
export class DiagnosticModule {}
