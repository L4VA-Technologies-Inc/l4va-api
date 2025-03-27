import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import {Vault} from "../../database/vault.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Vault])],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}
