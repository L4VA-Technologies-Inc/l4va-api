import {Controller, Get, Query, UseGuards} from '@nestjs/common';
import { TaptoolsService } from './taptools.service';
import {AuthGuard} from '../auth/auth.guard';
import {ApiDoc} from '../../decorators/api-doc.decorator';
import {ApiTags} from '@nestjs/swagger';

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
