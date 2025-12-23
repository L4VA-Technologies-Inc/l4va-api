import { Module } from '@nestjs/common';

import { AlertsService } from './alerts.service';

@Module({
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
