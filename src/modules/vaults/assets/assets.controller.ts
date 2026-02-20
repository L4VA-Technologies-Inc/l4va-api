import { Controller, Get, Post, Body, Query, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { AssetsService } from './assets.service';
import { GetAcquiredAssetsReq } from './dto/get-acquired-assets.req';
import { GetAcquiredAssetsRes } from './dto/get-acquired-assets.res';
import { GetContributedAssetsReq } from './dto/get-contributed-assets.req';
import { GetContributedAssetsRes } from './dto/get-contributed-assets.res';

import { ApiDoc } from '@/decorators/api-doc.decorator';

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @ApiDoc({
    summary: 'Get contributed vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @Post('contributed/:vaultId')
  @ApiResponse({ type: GetContributedAssetsRes, status: 200 })
  getContributedAssets(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() body: GetContributedAssetsReq
  ): Promise<GetContributedAssetsRes> {
    return this.assetsService.getVaultAssets(vaultId, body.page, body.limit, body.search, body.filter);
  }

  @ApiDoc({
    summary: 'Get acquired vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @Get('acquired/:vaultId')
  @ApiResponse({ type: GetAcquiredAssetsRes, status: 200 })
  getInvestedAssets(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Query() query: GetAcquiredAssetsReq
  ): Promise<GetAcquiredAssetsRes> {
    return this.assetsService.getAcquiredAssets(
      vaultId,
      query.page,
      query.limit,
      query.search,
      query.minQuantity,
      query.maxQuantity
    );
  }
}
