import { Module } from '@nestjs/common';

import { PresaleController } from './presale.controller';
import { PresaleService } from './presale.service';

@Module({
  controllers: [PresaleController],
  providers: [PresaleService],
  exports: [PresaleService],
})
export class PresaleModule {}
