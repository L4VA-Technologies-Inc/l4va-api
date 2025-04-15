import { Controller, Get, Query } from '@nestjs/common';
import { TaptoolsService } from './taptools.service';

@Controller('taptools')
export class TaptoolsController {
  constructor(private readonly taptoolsService: TaptoolsService) {}

  @Get('summary')
  async getWalletSummary(@Query('address') address: string) {
    return this.taptoolsService.getWalletSummary(address);
  }
}
