import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { StakeAnalyticsRes } from './dto/stake-analytics.res';
import { StakeAdminService } from './stake-admin.service';

import { AdminGuard } from '@/modules/auth/admin.guard';

@ApiTags('stake-admin')
@Controller('stake-admin')
@UseGuards(AdminGuard)
@ApiSecurity('Admin-Token')
export class StakeAdminController {
  constructor(private readonly stakeAdminService: StakeAdminService) {}

  @Get('analytics')
  @ApiOperation({
    summary: 'Staking analytics snapshot (admin only)',
    description:
      'Returns a comprehensive analytics snapshot of the staking protocol. ' +
      'Includes total staked amounts per token, unique staker counts, pending rewards ' +
      'the admin owes users, transaction statistics, top stakers, and APY configuration.',
  })
  @ApiResponse({ status: 200, type: StakeAnalyticsRes })
  async getAnalytics(): Promise<StakeAnalyticsRes> {
    return this.stakeAdminService.getStakingAnalytics();
  }
}
