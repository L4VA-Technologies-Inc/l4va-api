import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AcquireController } from './acquire.controller';
import { AcquireService } from './acquire.service';
import {Vault} from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {TransactionsModule} from '../transactions/transactions.module';
import {Asset} from "../../database/asset.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Vault, User, Asset]), TransactionsModule],
  controllers: [AcquireController],
  providers: [AcquireService],
  exports: [AcquireService],
})
export class AcquireModule {}
