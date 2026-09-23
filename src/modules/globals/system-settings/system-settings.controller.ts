import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { NftFlagsResponseDto } from './dto/nft-flags-response.dto';
import { SystemSettingsResponseDto } from './dto/settings-response.dto';
import { VaultCreationFlagsResponseDto } from './dto/vault-creation-flags-response.dto';
import { VlrmFeeResponseDto } from './dto/vlrm-fee-response.dto';
import { SystemSettingsService } from './system-settings.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ChainType } from '@/types/vault.types';

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

  @Get('vault-creation-flags')
  @UseGuards(AuthGuard)
  @ApiDoc({
    summary: 'Get the vault-creation feature flags',
    description:
      'What the create-vault flows may offer: NFT assets on EVM, and the vault archetypes available per chain.',
    status: 200,
  })
  @ApiResponse({
    status: 200,
    description: 'Vault creation flags',
    type: VaultCreationFlagsResponseDto,
  })
  getVaultCreationFlags(): VaultCreationFlagsResponseDto {
    return {
      evm_nft_assets_enabled: this.systemSettingsService.evmNftAssetsEnabled,
      vault_archetypes_enabled: {
        [ChainType.cardano]: this.systemSettingsService.vaultArchetypesEnabled(ChainType.cardano),
        [ChainType.robinhood]: this.systemSettingsService.vaultArchetypesEnabled(ChainType.robinhood),
      },
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
