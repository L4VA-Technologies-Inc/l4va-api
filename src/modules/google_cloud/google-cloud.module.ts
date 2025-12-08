import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TransactionsModule } from '../vaults/processing-tx/offchain-tx/transactions.module';

import { AuditLogService } from './audit-log.service';
import { GoogleKMSService } from './google-kms.service';
import { GoogleSecretService } from './google-secret.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
  ],
  controllers: [],
  providers: [GoogleKMSService, GoogleSecretService, AuditLogService],
  exports: [GoogleKMSService, GoogleSecretService, AuditLogService],
})
export class GoogleCloudModule {}
