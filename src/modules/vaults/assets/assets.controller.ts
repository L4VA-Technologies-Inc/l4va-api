import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AssetsService } from './assets.service';

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
  getContributedAssets(
    @Param('vaultId') vaultId: string,
    @Body() body: { search: string; page: number; limit: number }
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    return this.assetsService.getVaultAssets(vaultId, body.page, body.limit, body.search);
  }

  @ApiDoc({
    summary: 'Get acquired vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @Get('acquired/:vaultId')
  getInvestedAssets(
    @Param('vaultId') vaultId: string,
    @Query() query: PaginationDto
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    return this.assetsService.getAcquiredAssets(vaultId, query.page, query.limit);
  }
}
