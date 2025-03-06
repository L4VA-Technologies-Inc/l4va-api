import { Module } from '@nestjs/common';
import { AwsService } from './aws.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../../database/file.entity';
import {AwsController} from "./aws.controller";

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity])],
  controllers: [AwsController],
  providers: [AwsService],
  exports: [AwsService],
})
export class AwsModule {}
