import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GoogleCloudStorageController } from './bucket.controller';
import { GoogleCloudStorageService } from './bucket.service';

import { FileEntity } from '@/database/file.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([FileEntity]),
    HttpModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        global: true,
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [GoogleCloudStorageController],
  providers: [GoogleCloudStorageService],
  exports: [GoogleCloudStorageService],
})
export class GoogleCloudStorageModule {}
