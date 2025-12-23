import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SentryInterceptor } from './common/interceptors/sentry.interceptor';
import { SentryMonitoringService } from './common/services/sentry-monitoring.service';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { DexHunterModule } from './modules/dexhunter/dexhunter.module';
import { DistributionModule } from './modules/distribution/distribution.module';
import { JwtGlobalModule } from './modules/globals/jwt_global_module/jwt_global.module';
import { SystemSettingsModule } from './modules/globals/system-settings';
import { GoogleCloudModule } from './modules/google_cloud/google-cloud.module';
import { GoogleCloudStorageModule } from './modules/google_cloud/google_bucket/bucket.module';
import { UsersModule } from './modules/users/users.module';
import { ClaimsModule } from './modules/vaults/claims/claims.module';
import { AcquireModule } from './modules/vaults/phase-management/acquire/acquire.module';
import { ContributionModule } from './modules/vaults/phase-management/contribution/contribution.module';
import { GovernanceModule } from './modules/vaults/phase-management/governance/governance.module';
import { TransactionsModule } from './modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from './modules/vaults/processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from './modules/vaults/treasure/treasure-wallet.module';
import { VaultsModule } from './modules/vaults/vaults.module';
import { VyfiModule } from './modules/vyfi/vyfi.module';
import { WayUpModule } from './modules/wayup/wayup.module';

import { AlertsModule } from '@/modules/alerts/alerts.module';
import { NotificationModule } from '@/modules/notification/notification.module';
import { PresetsModule } from '@/modules/presets/presets.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';

@Module({
  imports: [
    SentryModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: 6379,
        role: 'master',
        password: process.env.REDIS_PASSWORD,
      },
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      synchronize: false,
      entities: [__dirname + '/database/core/**/*.entity{.ts,.js}', __dirname + '/database/**/*.entity{.ts,.js}'],
      autoLoadEntities: true,
      namingStrategy: new SnakeNamingStrategy(),
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 150,
        },
      ],
    }),
    JwtGlobalModule,
    SystemSettingsModule,
    AuthModule,
    AlertsModule,
    AssetsModule,
    BlockchainModule,
    VaultsModule,
    UsersModule,
    GoogleCloudStorageModule,
    ContributionModule,
    AcquireModule,
    TransactionsModule,
    DistributionModule,
    ClaimsModule,
    VyfiModule,
    GovernanceModule,
    NotificationModule,
    ChatModule,
    GoogleCloudModule,
    TreasureWalletModule,
    DexHunterModule,
    WayUpModule,
    EventEmitterModule.forRoot(),
    PresetsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    SentryMonitoringService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SentryInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
  ],
})
export class AppModule {}
