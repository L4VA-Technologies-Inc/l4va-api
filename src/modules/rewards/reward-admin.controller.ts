import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger';

import { RewardEpochConfigProxy } from './services/reward-epoch-config-proxy.service';

import { AdminGuard } from '@/modules/auth/admin.guard';

class CreateConfigDto {
  weekly_emission?: number;
  creator_share?: number;
  participant_share?: number;
  max_wallet_share?: number;
  max_wallet_reward?: number;
  vesting_immediate_ratio?: number;
  vesting_locked_ratio?: number;
  vesting_period_days?: number;
  lp_maturity_days?: number;
  lp_weight?: number;
  max_alignment_multiplier?: number;
  l4va_min_stake?: number;
  vlrm_min_stake?: number;
  alignment_bonus_per_tier?: number;
  epoch_duration_days?: number;
  snapshot_interval_days?: number;
  notes?: string;
  created_by: string;
}

class ActivateConfigDto {
  activated_by: string;
}

class CloneConfigDto {
  created_by: string;
  notes?: string;
}

/**
 * Admin endpoints for managing reward epoch configuration.
 * All endpoints are protected by AdminGuard.
 * Proxies requests to internal l4va-rewards service.
 */
@ApiTags('Admin - Rewards Config')
@Controller('admin/rewards/config')
@UseGuards(AdminGuard)
export class RewardAdminController {
  constructor(private readonly configProxy: RewardEpochConfigProxy) {}

  @Get('active')
  @ApiOperation({ summary: '[Admin] Get active config (will be used for next epoch)' })
  @ApiResponse({ status: 200, description: 'Active config returned' })
  async getActiveConfig(): Promise<any> {
    return this.configProxy.getActiveConfig();
  }

  @Get('list')
  @ApiOperation({ summary: '[Admin] List all configs with pagination' })
  @ApiResponse({ status: 200, description: 'List of configs' })
  async listConfigs(@Query('limit') limit = 20, @Query('offset') offset = 0): Promise<any> {
    return this.configProxy.listConfigs(limit, offset);
  }

  @Get(':version')
  @ApiOperation({ summary: '[Admin] Get config by version number' })
  @ApiResponse({ status: 200, description: 'Config returned' })
  @ApiResponse({ status: 404, description: 'Config not found' })
  async getConfigByVersion(@Param('version', ParseIntPipe) version: number): Promise<any> {
    return this.configProxy.getConfigByVersion(version);
  }

  @Post('draft')
  @ApiOperation({ summary: '[Admin] Create a new draft config' })
  @ApiResponse({ status: 201, description: 'Draft config created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  async createDraft(@Body() dto: CreateConfigDto): Promise<any> {
    return this.configProxy.createDraft(dto);
  }

  @Put(':version/activate')
  @ApiOperation({ summary: '[Admin] Activate a config (will be used for next epoch)' })
  @ApiResponse({ status: 200, description: 'Config activated' })
  @ApiResponse({ status: 400, description: 'Config not found or invalid' })
  async activateConfig(@Param('version', ParseIntPipe) version: number, @Body() dto: ActivateConfigDto): Promise<any> {
    return this.configProxy.activateConfig(version, dto.activated_by);
  }

  @Post(':version/clone')
  @ApiOperation({ summary: '[Admin] Clone an existing config as a new draft' })
  @ApiResponse({ status: 201, description: 'Config cloned' })
  @ApiResponse({ status: 400, description: 'Source config not found' })
  async cloneConfig(@Param('version', ParseIntPipe) version: number, @Body() dto: CloneConfigDto): Promise<any> {
    return this.configProxy.cloneConfig(version, dto.created_by, dto.notes);
  }

  @Delete(':version')
  @ApiOperation({ summary: '[Admin] Delete a draft config (cannot delete active configs)' })
  @ApiResponse({ status: 200, description: 'Draft config deleted' })
  @ApiResponse({ status: 400, description: 'Config not found or cannot be deleted' })
  async deleteDraft(@Param('version', ParseIntPipe) version: number): Promise<void> {
    return this.configProxy.deleteDraft(version);
  }
}
