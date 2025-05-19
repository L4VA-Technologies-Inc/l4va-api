import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaptoolsService } from './taptools.service';
import { TaptoolsController } from './taptools.controller';
import { Vault } from '../../database/vault.entity';
import { Asset } from '../../database/asset.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, Asset]),
  ],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
