import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Vault } from '../../database/vault.entity';
import { ContributionModule } from '../contribution/contribution.module';
import { TaptoolsModule } from '../taptools/taptools.module';

import { LifecycleService } from './lifecycle.service';

@Module({
  imports: [ContributionModule, TypeOrmModule.forFeature([Vault]), ScheduleModule.forRoot(), TaptoolsModule],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
