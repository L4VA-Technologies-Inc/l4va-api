import {forwardRef, Module} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Vault } from '../../../../database/vault.entity';
import { LifecycleService } from './lifecycle.service';
import { ContributionModule } from '../contribution/contribution.module';
import {VaultsModule} from "../../vaults.module";
import {BlockchainModule} from "../../processing-tx/onchain/blockchain.module";

@Module({
  imports: [
    ContributionModule,
    TypeOrmModule.forFeature([Vault]),
    ScheduleModule.forRoot(),
    forwardRef(() => VaultsModule),
    forwardRef(() => BlockchainModule)
  ],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
