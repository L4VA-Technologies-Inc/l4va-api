import { INestApplication, Logger, type LogLevel } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { deployStack, type DeployedStack } from './deploy-stack';
import { assertLifecycleTestEnv } from './guard';

import { AppModule } from '@/app.module';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { PriceService } from '@/modules/price/price.service';
import { LifecycleService } from '@/modules/vaults/phase-management/lifecycle/lifecycle.service';

export const ETH_USD = 2500;

export interface TestApp {
  app: INestApplication;
  stack: DeployedStack;
  dataSource: DataSource;
  lifecycle: LifecycleService;
  alerts: jest.SpyInstance;
  /** Run one full lifecycle cron pass, exactly as the every-minute job does. */
  tick(times?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot the real AppModule against the lifecycle-test services, with every
 * scheduled job stopped so tests drive the lifecycle explicitly.
 */
export async function createTestApp(): Promise<TestApp> {
  // Env is loaded by setup-env.ts before any module import.
  assertLifecycleTestEnv();

  // Contracts must exist before services read their addresses from config.
  const stack = await deployStack();
  process.env.EVM_FACTORY_ADDRESS = stack.factory;
  process.env.EVM_BATCH_DEPLOYER_ADDRESS = stack.batchDeployer;
  process.env.EVM_ADAPTER_REGISTRY_ADDRESS = stack.adapterRegistry;

  // LIFECYCLE_TEST_LOG=debug shows every lifecycle decision (skip reasons are logged at debug).
  const logLevels: LogLevel[] =
    process.env.LIFECYCLE_TEST_LOG === 'debug' ? ['error', 'warn', 'log', 'debug'] : ['error', 'warn'];
  Logger.overrideLogger(logLevels);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: logLevels });
  await app.init();

  const scheduler = app.get(SchedulerRegistry);
  scheduler.getCronJobs().forEach(job => job.stop());
  scheduler.getIntervals().forEach(name => scheduler.deleteInterval(name));
  scheduler.getTimeouts().forEach(name => scheduler.deleteTimeout(name));

  // Nothing here may leave the machine.
  const price = app.get(PriceService);
  jest.spyOn(price, 'getEthPrice').mockResolvedValue(ETH_USD);
  jest.spyOn(price, 'getAdaPrice').mockResolvedValue(0.5);
  const alerts = jest.spyOn(app.get(AlertsService), 'sendAlert').mockResolvedValue(undefined);

  const lifecycle = app.get(LifecycleService);
  return {
    app,
    stack,
    dataSource: app.get(DataSource),
    lifecycle,
    alerts,
    async tick(times = 1) {
      for (let i = 0; i < times; i++) await lifecycle.handleVaultLifecycleTransitions();
    },
    async close() {
      await app.close();
    },
  };
}
