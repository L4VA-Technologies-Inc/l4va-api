import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DistributionService } from './distribution.service';
import { LiquidityPoolService } from './lp.service';

ApiTags('Distribution');
@Controller('distribution')
export class DistributionController {
  constructor(
    private readonly distributionService: DistributionService,
    private readonly liquidityPoolService: LiquidityPoolService
  ) {}

  /**
   * Example calculation for a contributor.
   * Query params:
   * - adaSent: number
   * - contributorPercentVt: number
   * - contributorLpPercent: number
   */
  @Get('contributor-example')
  contributorExample(
    @Query('adaSent') adaSent: string,
    @Query('contributorPercentVt') contributorPercentVt: string,
    @Query('contributorLpPercent') contributorLpPercent: string
  ) {
    return this.distributionService.calculateContributorExample({
      adaSent: Number(adaSent),
      contributorPercentVt: Number(contributorPercentVt),
      contributorLpPercent: Number(contributorLpPercent),
    });
  }

  /**
   * Example calculation for an acquirer.
   * Query params:
   * - adaSent: number
   * - numAcquirers: number
   */
  @Get('acquirer-example')
  acquirerExample(@Query('adaSent') adaSent: string, @Query('numAcquirers') numAcquirers: string) {
    return this.distributionService.calculateAcquirerExample({
      adaSent: Number(adaSent),
      numAcquirers: Number(numAcquirers),
    });
  }
}
