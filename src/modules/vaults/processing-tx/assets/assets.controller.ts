import { Controller, Get, Query, Param, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../../../decorators/api-doc.decorator';
import { AuthGuard } from '../../../auth/auth.guard';
import { PaginationDto } from '../../dto/pagination.dto';

import { AssetsService } from './assets.service';

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @ApiDoc({
    summary: 'Get vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('contributed/:vaultId')
  getContributedAssets(@Request() req, @Param('vaultId') vaultId: string, @Query() query: PaginationDto) {
    const userId = req.user.sub;
    return this.assetsService.getVaultAssets(userId, vaultId, query.page, query.limit);
  }

  @ApiDoc({
    summary: 'Get vault assets',
    description: 'Get paginated list of assets for a specific vault',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('acquired/:vaultId')
  getInvestedAssets(@Request() req, @Param('vaultId') vaultId: string, @Query() query: PaginationDto) {
    const userId = req.user.sub;
    return this.assetsService.getAcquiredAssets(userId, vaultId, query.page, query.limit);
  }
}
