import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributionService } from './distribution.service';

import { Vault } from '@/database/vault.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vault])],
  providers: [DistributionService],
  exports: [DistributionService],
})
export class DistributionModule {}
