import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { AwsModule } from './modules/aws_bucket/aws.module';
import { ChatModule } from './modules/chat/chat.module';
import { DistributionModule } from './modules/distribution/distribution.module';
import { JwtGlobalModule } from './modules/globals/jwt_global_module/jwt_global.module';
import { UsersModule } from './modules/users/users.module';
import { ClaimsModule } from './modules/vaults/claims/claims.module';
import { LpTokensModule } from './modules/vaults/lp-tokens/lp-tokens.module';
import { AcquireModule } from './modules/vaults/phase-management/acquire/acquire.module';
import { ContributionModule } from './modules/vaults/phase-management/contribution/contribution.module';
import { GovernanceModule } from './modules/vaults/phase-management/governance/governance.module';
import { AssetsModule } from './modules/vaults/processing-tx/assets/assets.module';
import { TransactionsModule } from './modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from './modules/vaults/processing-tx/onchain/blockchain.module';
import { VaultsModule } from './modules/vaults/vaults.module';
import { VyfiModule } from './modules/vyfi/vyfi.module';

import { NotificationModule } from '@/modules/notification/notification.module';
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: 6379,
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
          limit: 50,
        },
      ],
    }),
    JwtGlobalModule,
    AuthModule,
    AssetsModule,
    BlockchainModule,
    VaultsModule,
    UsersModule,
    AwsModule,
    ContributionModule,
    AcquireModule,
    TransactionsModule,
    LpTokensModule,
    DistributionModule,
    ClaimsModule,
    VyfiModule,
    GovernanceModule,
    NotificationModule,
    ChatModule,
    EventEmitterModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
