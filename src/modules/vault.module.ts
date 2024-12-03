import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Vault } from '../entities/vault.entity';
import { VaultService } from '../services/vault.service';
import { VaultController } from '../controllers/vault.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Vault])],
  controllers: [VaultController],
  providers: [VaultService],
})
export class VaultModule {}
