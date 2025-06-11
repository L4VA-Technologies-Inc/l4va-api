import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AcquireModule } from './modules/acquire/acquire.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthModule } from './modules/auth/auth.module';
import { AwsModule } from './modules/aws_bucket/aws.module';
import { BlockchainModule } from './modules/blockchain/blockchain.module';
import { ContributionModule } from './modules/contribution/contribution.module';
import { JwtGlobalModule } from './modules/globals/jwt_global_module/jwt_global.module';
import { TaptoolsModule } from './modules/taptools/taptools.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { UsersModule } from './modules/users/users.module';
import { VaultsModule } from './modules/vaults/vaults.module';
import { VyfiModule } from './modules/vyfi/vyfi.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      synchronize: false,
      entities: [__dirname + '/database/core/**/*.entity{.ts,.js}'],
      autoLoadEntities: true,
      namingStrategy: new SnakeNamingStrategy(),
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
    TaptoolsModule,
    LpTokensModule,
    VyfiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
