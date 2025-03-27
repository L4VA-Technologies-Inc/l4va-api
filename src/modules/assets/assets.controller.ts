import { Controller, Post, Get, Patch, Body, Query, Param, Request, UseGuards } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { AuthGuard } from '../auth/auth.guard';
import { CreateAssetDto } from './dto/create-asset.dto';
import { ApiTags } from '@nestjs/swagger';
import { ApiDoc } from '../../decorators/api-doc.decorator';
import { PaginationDto } from '../vaults/dto/pagination.dto';

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
  @Get('vault/:vaultId')
  getVaultAssets(
    @Request() req,
    @Param('vaultId') vaultId: string,
    @Query() query: PaginationDto
  ) {
    const userId = req.user.sub;
    return this.assetsService.getVaultAssets(userId, vaultId, query.page, query.limit);
  }


}
