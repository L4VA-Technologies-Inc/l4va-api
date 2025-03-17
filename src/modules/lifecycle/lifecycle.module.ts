import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Vault } from '../../database/vault.entity';
import { LifecycleService } from './lifecycle.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault]),
    ScheduleModule.forRoot(),
  ],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
