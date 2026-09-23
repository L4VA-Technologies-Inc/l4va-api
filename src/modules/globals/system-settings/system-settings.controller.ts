import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { NftFlagsResponseDto } from './dto/nft-flags-response.dto';
import { SystemSettingsResponseDto } from './dto/settings-response.dto';
import { VlrmFeeResponseDto } from './dto/vlrm-fee-response.dto';
import { SystemSettingsService } from './system-settings.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { AuthGuard } from '@/modules/auth/auth.guard';

@ApiTags('System Settings')
@Controller('system-settings')
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get('vlrm-fee')
  @UseGuards(AuthGuard)
  @ApiDoc({
    summary: 'Get VLRM creator fee settings',
    description: 'Returns VLRM creator fee and enabled status',
    status: 200,
  })
  @ApiResponse({
    status: 200,
    description: 'VLRM fee settings',
    type: VlrmFeeResponseDto,
  })
  getVlrmFeeSettings(): VlrmFeeResponseDto {
    return {
      vlrm_creator_fee: this.systemSettingsService.vlrmCreatorFee / 10000,
      vlrm_creator_fee_enabled: this.systemSettingsService.vlrmCreatorFeeEnabled,
    };
  }

  @Get('nft-flags')
  @UseGuards(AuthGuard)
  @ApiDoc({
    summary: 'Get NFT asset feature flags',
    description: 'Returns whether NFT assets are enabled on EVM (Robinhood-chain) vaults',
    status: 200,
  })
  @ApiResponse({
    status: 200,
    description: 'NFT feature flags',
    type: NftFlagsResponseDto,
  })
  getNftFlags(): NftFlagsResponseDto {
    return {
      evm_nft_assets_enabled: this.systemSettingsService.evmNftAssetsEnabled,
    };
  }

  @Post('reload')
  @UseGuards(AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reload settings from database (useful after manual DB updates)',
  })
  @ApiResponse({
    status: 200,
    description: 'Settings reloaded from database',
    type: SystemSettingsResponseDto,
  })
  async reloadSettings(): Promise<SystemSettingsResponseDto> {
    return await this.systemSettingsService.reloadSettings();
  }
}
