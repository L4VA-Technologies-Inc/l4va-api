import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UsersModule } from '../users/users.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [UsersModule, TypeOrmModule.forFeature([User, Vault])],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
