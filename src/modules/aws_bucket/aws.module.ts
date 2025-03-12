import { Module } from '@nestjs/common';
import { AwsService } from './aws.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../../database/file.entity';
import {AwsController} from './aws.controller';
import {HttpModule} from '@nestjs/axios';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), HttpModule],
  controllers: [AwsController],
  providers: [AwsService],
  exports: [AwsService],
})
export class AwsModule {}
