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
    summary: 'Add asset to vault',
    description: 'Add a new asset to a vault during contribution phase',
    status: 201,
  })
  @UseGuards(AuthGuard)
  @Post()
  addAssetToVault(
    @Request() req,
    @Body() data: CreateAssetDto
  ) {
    const userId = req.user.sub;
    return this.assetsService.addAssetToVault(userId, data);
  }

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

  @ApiDoc({
    summary: 'Lock asset',
    description: 'Lock a pending asset',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Patch(':assetId/lock')
  lockAsset(
    @Request() req,
    @Param('assetId') assetId: string
  ) {
    const userId = req.user.sub;
    return this.assetsService.lockAsset(userId, assetId);
  }

  @ApiDoc({
    summary: 'Release asset',
    description: 'Release a locked asset',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Patch(':assetId/release')
  releaseAsset(
    @Request() req,
    @Param('assetId') assetId: string
  ) {
    const userId = req.user.sub;
    return this.assetsService.releaseAsset(userId, assetId);
  }

  @ApiDoc({
    summary: 'Update asset valuation',
    description: 'Update floor price for NFTs or DEX price for CNTs',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Patch(':assetId/valuation')
  updateAssetValuation(
    @Request() req,
    @Param('assetId') assetId: string,
    @Body() data: { floorPrice?: number; dexPrice?: number }
  ) {
    const userId = req.user.sub;
    return this.assetsService.updateAssetValuation(userId, assetId, data.floorPrice, data.dexPrice);
  }
}
