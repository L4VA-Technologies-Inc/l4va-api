import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatEther } from 'viem';

import { EvmAdminSigner } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';

import { AlertsService } from '@/modules/alerts/alerts.service';

/**
 * Slack alert when the Robinhood admin wallet (closeCycle / claim / refund / LP signer)
 * runs low on gas. Every admin-signed flow stalls once it is empty.
 * Threshold: EVM_ADMIN_MIN_GAS_WEI (unset or 0 = disabled).
 */
@Injectable()
export class EvmAdminGasMonitorService {
  private readonly logger = new Logger(EvmAdminGasMonitorService.name);
  private readonly minGasWei: bigint;

  constructor(
    configService: ConfigService,
    private readonly adminSigner: EvmAdminSigner,
    private readonly contractReader: EvmContractReader,
    private readonly alerts: AlertsService
  ) {
    this.minGasWei = BigInt(configService.get<string>('EVM_ADMIN_MIN_GAS_WEI') || '0');
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async check(): Promise<void> {
    if (this.minGasWei <= 0n) return;
    try {
      const balance: bigint = await this.contractReader.publicClient.getBalance({ address: this.adminSigner.address });
      if (balance < this.minGasWei) {
        await this.alerts.sendAlert('evm_admin_low_gas', {
          chain: 'robinhood',
          admin: this.adminSigner.address,
          balanceEth: formatEther(balance),
          minEth: formatEther(this.minGasWei),
        });
      }
    } catch (err) {
      this.logger.error(`Admin gas balance check failed: ${(err as Error).message}`);
    }
  }
}
