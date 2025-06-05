import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Vault } from '../../../../database/vault.entity';
import { LifecycleService } from './lifecycle.service';
import { ContributionModule } from '../contribution/contribution.module';
import { TaptoolsModule } from '../../../taptools/taptools.module';

@Module({
  imports: [
    ContributionModule,
    TypeOrmModule.forFeature([Vault]),
    ScheduleModule.forRoot(),
    TaptoolsModule,
  ],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
