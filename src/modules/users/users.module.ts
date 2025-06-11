import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FileEntity } from '../../database/file.entity';
import { LinkEntity } from '../../database/link.entity';
import { User } from '../../database/user.entity';
import { AwsModule } from '../aws_bucket/aws.module';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, FileEntity, LinkEntity]), AwsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
