import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { AssetsService } from './assets.service';
import { GetContributedAssetsReq } from './dto/get-contributed-assets.req';
import { GetContributedAssetsRes } from './dto/get-contributed-assets.res';
import { GetAcquiredAssetsRes } from './dto/get-acquired-assets.res';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { PaginationDto } from '@/modules/vaults/dto/pagination.dto';

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
    @Param('vaultId') vaultId: string,
    @Body() body: GetContributedAssetsReq
  ): Promise<GetContributedAssetsRes> {
    return this.assetsService.getVaultAssets(vaultId, body.page, body.limit, body.search);
  }

  @ApiDoc({
    summary: 'Get acquired vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @Get('acquired/:vaultId')
  @ApiResponse({ type: GetAcquiredAssetsRes, status: 200 })
  getInvestedAssets(@Param('vaultId') vaultId: string, @Query() query: PaginationDto): Promise<GetAcquiredAssetsRes> {
    return this.assetsService.getAcquiredAssets(vaultId, query.page, query.limit);
  }
}
