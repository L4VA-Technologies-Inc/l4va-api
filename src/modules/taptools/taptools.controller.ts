import { Controller, Get, UseGuards, Query, Param, Body, Post } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

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

  @Get('assets/:id')
  @ApiDoc({
    summary: 'Get asset quantity in wallet',
    description: 'Returns number of specified asset on wallet',
    status: 200,
  })
  @ApiQuery({ name: 'address', type: String, description: 'Wallet address' })
  @ApiResponse({ status: 404, description: 'Asset not found' })
  @UseGuards(AuthGuard)
  async getAssetDetails(@Param('id') assetId: string, @Query('address') walletAddress: string): Promise<number> {
    return this.taptoolsService.getWalletAssetsQuantity(walletAddress, assetId);
  }

  @Get('wallet-policies')
  @ApiDoc({
    summary: 'Get unique policy IDs from wallet',
    description: 'Returns all unique policy IDs and their names from a wallet address',
    status: 200,
  })
  @ApiQuery({ name: 'address', type: String, description: 'Wallet address' })
  @ApiResponse({ status: 200, type: Array })
  @UseGuards(AuthGuard)
  async getWalletPolicyIds(
    @Query('address') address: string,
    @Query('excludeFTs') excludeFTs: boolean = false
  ): Promise<
    {
      policyId: string;
      name: string;
    }[]
  > {
    return this.taptoolsService.getWalletPolicyIds(address, excludeFTs);
  }
}
