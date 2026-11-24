import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { RewardEstimateProxy } from './services/reward-estimate-proxy.service';

import { AdminGuard } from '@/modules/auth/admin.guard';

class SimulateEstimateDto {
  @IsOptional()
  @IsUUID()
  epochId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  topWalletsLimit?: number;
}

/**
 * Admin endpoint for per-wallet reward estimation of an epoch (no persistence).
 * Proxies requests to internal l4va-rewards service.
 */
@ApiTags('Admin - Rewards Estimate')
@Controller('admin/rewards/estimate')
@UseGuards(AdminGuard)
export class RewardEstimateAdminController {
  constructor(private readonly estimateProxy: RewardEstimateProxy) {}

  @Post()
  @ApiOperation({ summary: '[Admin] Dry-run reward estimation for all wallets (current epoch by default)' })
  @ApiResponse({ status: 201, description: 'Estimation returned' })
  async simulate(@Body() dto: SimulateEstimateDto): Promise<any> {
    return this.estimateProxy.simulateEpochEstimate({
      epochId: dto.epochId,
      topWalletsLimit: dto.topWalletsLimit,
    });
  }
}
