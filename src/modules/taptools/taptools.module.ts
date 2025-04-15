import { Module } from '@nestjs/common';
import { TaptoolsService } from './taptools.service';
import { TaptoolsController } from './taptools.controller';

@Module({
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
