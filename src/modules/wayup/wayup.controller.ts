import { Controller, Post, Get, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { AuthGuard } from '../auth/auth.guard';

import { CreateListingDto, UpdateListingDto } from './dto/create-listing.dto';
import { SubmitListingTxDto } from './dto/submit-listing-tx.dto';
import { WayupService } from './wayup.service';

@ApiTags('Way-up Integration')
@Controller('wayup')
@UseGuards(AuthGuard)
export class WayupController {
  constructor(private readonly wayupService: WayupService) {}

  @Get('vaults/:vaultId/listable-assets')
  @ApiOperation({ summary: 'Get assets available for listing from vault' })
  async getListableAssets(@Param('vaultId') vaultId: string) {
    return this.wayupService.getListableAssets(vaultId);
  }

  @Post('vaults/:vaultId/assets/:assetId/list')
  @ApiOperation({ summary: 'Create asset listing on Way-up' })
  async createAssetListing(
    @Param('vaultId') vaultId: string,
    @Param('assetId') assetId: string,
    @Body() listingData: CreateListingDto,
    @Req() req: Request & { user: { sub: string } }
  ) {
    const userId = req?.user.sub;
    return this.wayupService.createAssetListing(vaultId, assetId, userId, listingData);
  }

  @Post('assets/:assetId/submit')
  @ApiOperation({ summary: 'Submit signed listing transactions' })
  async submitListingTransaction(@Param('assetId') assetId: string, @Body() txData: SubmitListingTxDto) {
    return this.wayupService.submitListingTransaction(assetId, txData);
  }

  @Post('vaults/:vaultId/assets/:assetId/update-listing')
  @ApiOperation({ summary: 'Update asset listing price on Way-up' })
  async updateAssetListing(
    @Param('assetId') assetId: string,
    @Body() updateData: UpdateListingDto,
    @Req() req: Request & { user: { sub: string } }
  ) {
    const userId = req?.user.sub;
    return this.wayupService.updateAssetListing(assetId, userId, updateData);
  }
}
