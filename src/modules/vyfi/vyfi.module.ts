import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { VyfiController } from './vyfi.controller';
import { VyfiService } from './vyfi.service';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [VyfiController],
  providers: [VyfiService],
  exports: [VyfiService],
})
export class VyfiModule {}
