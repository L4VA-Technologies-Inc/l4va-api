import { Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { NftFlagsResponseDto } from './dto/nft-flags-response.dto';
import { SystemSettingsResponseDto } from './dto/settings-response.dto';
import { VaultCreationFlagsResponseDto } from './dto/vault-creation-flags-response.dto';
import { VlrmFeeResponseDto } from './dto/vlrm-fee-response.dto';
import { SystemSettingsService } from './system-settings.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { basketAssetCapFor, currentEvmVersionRef } from '@/modules/vaults/processing-tx/onchain/evm-protocol-versions';
import { ChainType } from '@/types/vault.types';

@ApiTags('System Settings')
@Controller('system-settings')
export class SystemSettingsController {
  constructor(
    private readonly systemSettingsService: SystemSettingsService,
    private readonly jwtService: JwtService
  ) {}

  // No auth guard on purpose: an expired or invalid token must read as "anonymous", not 401 —
  // the client would otherwise treat the error as an outage.
  @Get('site-access')
  @ApiDoc({
    summary: 'Whether the caller may use the site',
    description:
      'Closed-launch gate: `maintenance` is the site-wide flag, `allowed` is true when maintenance is off or the signed-in wallet is allowlisted.',
    status: 200,
  })
  async getSiteAccess(
    @Headers('authorization') authorization?: string
  ): Promise<{ maintenance: boolean; allowed: boolean }> {
    const maintenance = this.systemSettingsService.maintenanceMode;
    if (!maintenance) return { maintenance, allowed: true };

    const [type, token] = authorization?.split(' ') ?? [];
    let address: string | undefined;
    if (type === 'Bearer' && token) {
      try {
        address = (await this.jwtService.verifyAsync<{ address?: string }>(token))?.address;
      } catch {
        address = undefined;
      }
    }
    return { maintenance, allowed: this.systemSettingsService.isAllowedDuringMaintenance(address) };
  }

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

  // Public on purpose: the vault browse pages (Acquire/Govern) read the archetype filter from
  // these flags, and anonymous visitors must not get a 401 (the client logs out/redirects on 401).
  @Get('vault-creation-flags')
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
      evm_enabled: this.systemSettingsService.evmEnabled,
      evm_nft_assets_enabled: this.systemSettingsService.evmNftAssetsEnabled,
      evm_vault_cancel_enabled: this.systemSettingsService.evmVaultCancelEnabled,
      evm_contribution_withdraw_enabled: this.systemSettingsService.evmContributionWithdrawEnabled,
      evm_staking_enabled: this.systemSettingsService.evmStakingEnabled,
      vault_archetypes_enabled: {
        [ChainType.cardano]: this.systemSettingsService.vaultArchetypesEnabled(ChainType.cardano),
        [ChainType.robinhood]: this.systemSettingsService.vaultArchetypesEnabled(ChainType.robinhood),
      },
      evm_max_basket_assets: basketAssetCapFor(currentEvmVersionRef()),
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
