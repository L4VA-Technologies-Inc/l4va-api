import { Controller, UseGuards, Body, Post } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

import { PaginationQueryDto } from './dto/pagination.dto';
import { PaginatedWalletSummaryDto } from './dto/wallet-summary.dto';
import { TaptoolsService } from './taptools.service';

@Controller('taptools')
@ApiTags('TapTools')
export class TaptoolsController {
  constructor(private readonly taptoolsService: TaptoolsService) {}

  @Post('summary')
  @ApiDoc({
    summary: 'Get paginated wallet summary',
    description: 'Returns paginated assets from a wallet with optional filtering',
    status: 200,
  })
  @ApiResponse({ status: 200, type: PaginatedWalletSummaryDto })
  @ApiBody({ type: PaginationQueryDto })
  @UseGuards(AuthGuard)
  async getWalletSummaryPaginated(@Body() body: PaginationQueryDto): Promise<PaginatedWalletSummaryDto> {
    return this.taptoolsService.getWalletSummaryPaginated(body);
  }
}
