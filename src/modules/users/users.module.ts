import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from '../../database/user.entity';
import { FileEntity } from '../../database/file.entity';
import { LinkEntity } from '../../database/link.entity';
import { AwsModule } from '../aws_bucket/aws.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, FileEntity, LinkEntity]),
    AwsModule
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
