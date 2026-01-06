import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TaptoolsController } from './taptools.controller';
import { TaptoolsService } from './taptools.service';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { DexHunterPricingModule } from '@/modules/dexhunter/dexhunter-pricing.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { WayUpPricingModule } from '@/modules/wayup/wayup-pricing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, User]),
    AlertsModule,
    AssetsModule,
    DexHunterPricingModule,
    WayUpPricingModule,
  ],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
