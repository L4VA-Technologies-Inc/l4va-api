import { Module } from '@nestjs/common';

import { EnvCheckService } from './env-check.service';

import { AlertsModule } from '@/modules/alerts/alerts.module';

@Module({
  imports: [AlertsModule],
  providers: [EnvCheckService],
})
export class EnvCheckModule {}
