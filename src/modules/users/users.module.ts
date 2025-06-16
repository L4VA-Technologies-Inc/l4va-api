import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FileEntity } from 'src/database/file.entity';
import { LinkEntity } from 'src/database/link.entity';
import { User } from 'src/database/user.entity';
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
