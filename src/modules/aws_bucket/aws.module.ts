import { Module } from '@nestjs/common';
import { AwsService } from './aws.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../../database/file.entity';
import {AwsController} from './aws.controller';
import {HttpModule} from '@nestjs/axios';
import {JwtModule} from '@nestjs/jwt';
import {ConfigModule, ConfigService} from '@nestjs/config';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), HttpModule,  JwtModule.registerAsync({
    imports: [ConfigModule],
    useFactory: async (configService: ConfigService) => ({
      global: true,
      secret: configService.get<string>('JWT_SECRET'),
      signOptions: { expiresIn: '1d' },
    }),
    inject: [ConfigService],
  }),],
  controllers: [AwsController],
  providers: [AwsService],
  exports: [AwsService],
})
export class AwsModule {}
