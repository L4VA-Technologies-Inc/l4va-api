import { Global, Module } from '@nestjs/common';

import { PriceService } from './price.service';

import { NexusModule } from '@/modules/nexus/nexus.module';

@Global()
@Module({
  imports: [NexusModule],
  providers: [PriceService],
  exports: [PriceService],
})
export class PriceModule {}
