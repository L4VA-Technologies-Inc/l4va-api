import { Global, Module } from '@nestjs/common';

import { PriceService } from './price.service';

@Global()
@Module({
  providers: [PriceService],
  exports: [PriceService],
})
export class PriceModule {}
