import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexHunterController } from './dexhunter.controller';
import { DexHunterService } from './dexhunter.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [DexHunterController],
  providers: [DexHunterService],
  exports: [DexHunterService],
})
export class DexHunterModule {}
