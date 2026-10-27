import { Module } from '@nestjs/common';

import { BurnLockService } from './burn-lock.service';

@Module({
  providers: [BurnLockService],
  exports: [BurnLockService],
})
export class BurnLockModule {}
