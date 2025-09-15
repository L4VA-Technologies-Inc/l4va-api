import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WayUpController } from './wayup.controller';
import { WayUpService } from './wayup.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  controllers: [WayUpController],
  providers: [WayUpService],
  exports: [WayUpService],
})
export class WayUpModule {}
