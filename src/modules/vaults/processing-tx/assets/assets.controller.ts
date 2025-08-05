import { Controller, Get, Query, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PaginationDto } from '../../dto/pagination.dto';

import { AssetsService } from './assets.service';

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
  @Get('contributed/:vaultId')
  getContributedAssets(@Param('vaultId') vaultId: string, @Query() query: PaginationDto) {
    return this.assetsService.getVaultAssets(vaultId, query.page, query.limit);
  }

  @ApiDoc({
    summary: 'Get acquired vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @Get('acquired/:vaultId')
  getInvestedAssets(@Param('vaultId') vaultId: string, @Query() query: PaginationDto) {
    return this.assetsService.getAcquiredAssets(vaultId, query.page, query.limit);
  }
}
