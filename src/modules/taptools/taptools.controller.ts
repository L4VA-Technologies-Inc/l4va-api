import { Controller, Get, UseGuards, Query, Param } from '@nestjs/common';
import { ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

import { PaginationQueryDto } from './dto/pagination.dto';
import { PaginatedWalletSummaryDto } from './dto/wallet-summary.dto';
import { TaptoolsService } from './taptools.service';

@Controller('taptools')
@ApiTags('TapTools')
export class TaptoolsController {
  constructor(private readonly taptoolsService: TaptoolsService) {}

  @Get('summary-paginated')
  @ApiDoc({
    summary: 'Get paginated wallet summary with assets',
    description: 'Returns wallet overview and paginated assets for infinite scroll',
    status: 200,
  })
  @ApiResponse({ status: 200, type: PaginatedWalletSummaryDto })
  @ApiQuery({ name: 'address', type: String, description: 'Wallet address' })
  @ApiQuery({ name: 'page', type: Number, required: false, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: 'Items per page (default: 20, max: 100)' })
  @ApiQuery({
    name: 'filter',
    enum: ['all', 'nfts', 'tokens'],
    required: false,
    description: 'Filter by asset type (default: all)',
  })
  @UseGuards(AuthGuard)
  async getWalletSummaryPaginated(
    @Query('address') address: string,
    @Query() paginationQuery: PaginationQueryDto
  ): Promise<PaginatedWalletSummaryDto> {
    return this.taptoolsService.getWalletSummaryPaginated(address, paginationQuery);
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
  async getWalletPolicyIds(@Query('address') address: string): Promise<
    {
      policyId: string;
      name: string;
    }[]
  > {
    return this.taptoolsService.getWalletPolicyIds(address);
  }
}
