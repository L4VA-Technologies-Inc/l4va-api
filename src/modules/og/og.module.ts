import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OgController } from './og.controller';
import { OgService } from './og.service';

import { Vault } from '@/database/vault.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vault])],
  controllers: [OgController],
  providers: [OgService],
})
export class OgModule {}
