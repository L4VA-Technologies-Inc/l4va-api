import { Global, Module } from '@nestjs/common';

import { PriceController } from './price.controller';
import { PriceService } from './price.service';

import { NexusModule } from '@/modules/nexus/nexus.module';

@Global()
@Module({
  imports: [NexusModule],
  controllers: [PriceController],
  providers: [PriceService],
  exports: [PriceService],
})
export class PriceModule {}
