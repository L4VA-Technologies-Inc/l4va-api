import { Controller, Get, UseGuards, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

import { TaptoolsService } from './taptools.service';

@Controller('taptools')
@ApiTags('TapTools')
export class TaptoolsController {
  constructor(private readonly taptoolsService: TaptoolsService) {}

  @Get('summary')
  @ApiDoc({
    summary: 'Get info about price of wallet assets',
    description: 'Price select successfully',
    status: 200,
  })
  @UseGuards(AuthGuard)
  async getWalletSummary(@Query('address') address: string) {
    return this.taptoolsService.getWalletSummary(address);
  }
}
