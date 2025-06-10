import { Module } from '@nestjs/common';
import { VyfiService } from './vyfi.service';
import { VyfiController } from './vyfi.controller';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
  ],
  controllers: [VyfiController],
  providers: [VyfiService],
  exports: [VyfiService],
})
export class VyfiModule {} 