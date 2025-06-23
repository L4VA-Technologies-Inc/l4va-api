import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributionService } from './distribution.service';

import { Vault } from '@/database/vault.entity';

@Module({
  providers: [DistributionService],
  imports: [TypeOrmModule.forFeature([Vault])],
  exports: [DistributionService],
})
export class DistributionModule {}
