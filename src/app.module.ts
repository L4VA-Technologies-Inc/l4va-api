import { MiddlewareConsumer, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { VaultModule } from './modules/vault/vault.module';

import { databaseConfig } from './config/database.config';
import { AuthMiddleware } from './middlewares/auth.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuditInterceptor } from './interceptors/audit';
import { AuditEntity } from './entities/audit.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEntity]),
    TypeOrmModule.forRoot(databaseConfig),
    VaultModule,
    AuthModule,
    ThrottlerModule.forRoot([{
      ttl: 30000,
      limit: 3,
    }])
  ],
  controllers: [AppController],
  providers: [AppService, {
    provide: APP_GUARD,
    useClass: ThrottlerGuard
  },
  AuditInterceptor,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes('*');
  }
}
