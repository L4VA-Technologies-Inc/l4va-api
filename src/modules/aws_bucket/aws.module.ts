import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FileEntity } from '@/database/file.entity';

import { AwsController } from './aws.controller';
import { AwsService } from './aws.service';

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
  controllers: [AwsController],
  providers: [AwsService],
  exports: [AwsService],
})
export class AwsModule {}
