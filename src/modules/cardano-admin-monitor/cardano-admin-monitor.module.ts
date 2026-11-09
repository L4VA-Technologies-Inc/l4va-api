import { Global, Module } from '@nestjs/common';

import { CardanoAdminTxMonitorService } from './cardano-admin-tx-monitor.service';
import { CardanoAdminTxRegistry } from './cardano-admin-tx.registry';

import { AlertsModule } from '@/modules/alerts/alerts.module';

/** Global so every Cardano submit path can record its transaction in the registry. */
@Global()
@Module({
  imports: [AlertsModule],
  providers: [CardanoAdminTxRegistry, CardanoAdminTxMonitorService],
  exports: [CardanoAdminTxRegistry],
})
export class CardanoAdminMonitorModule {}
