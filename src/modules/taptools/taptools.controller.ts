import { Controller, Get, Param, UseGuards, NotFoundException, Query } from '@nestjs/common';
import { TaptoolsService } from './taptools.service';
import { AuthGuard } from '../auth/auth.guard';
import { ApiDoc } from '../../decorators/api-doc.decorator';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';

@Controller('taptools')
@ApiTags('TapTools')
export class TaptoolsController {
  constructor(private readonly taptoolsService: TaptoolsService) {}

  @Get('summary')
  @ApiDoc({
    summary: 'Get info about price of wallet assets',
    description: 'Price select successfully',
    status: 200,
  })
  @UseGuards(AuthGuard)
  async getWalletSummary(@Query('address') address: string) {
    return this.taptoolsService.getWalletSummary(address);
  }

  // @Get('vault/:vaultId/assets/value')
  // @ApiOperation({
  //   summary: 'Get the total value of assets in a vault',
  //   description: 'Calculates the total value of all assets in the specified vault in both ADA and USD.'
  // })
  // @ApiResponse({
  //   status: 200,
  //   description: 'Successfully retrieved vault assets value',
  //   type: VaultAssetsSummaryDto
  // })
  // @ApiResponse({
  //   status: 404,
  //   description: 'Vault not found'
  // })
  // @UseGuards(AuthGuard)
  // async getVaultAssetsValue(@Param('vaultId') vaultId: string): Promise<VaultAssetsSummaryDto> {
  //   try {
  //     return await this.taptoolsService.calculateVaultAssetsValue(vaultId);
  //   } catch (error) {
  //     if (error instanceof NotFoundException) {
  //       throw new NotFoundException(`Vault with ID ${vaultId} not found`);
  //     }
  //     throw error;
  //   }
  // }
}
