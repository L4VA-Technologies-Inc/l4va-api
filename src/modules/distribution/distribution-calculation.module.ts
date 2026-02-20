import { Module } from '@nestjs/common';

import { DistributionCalculationService } from './distribution-calculation.service';

/**
 * Shared module that provides calculation services for both
 * DistributionModule and GovernanceModule, preventing circular dependencies
 */
@Module({
  providers: [DistributionCalculationService],
  exports: [DistributionCalculationService],
})
export class DistributionCalculationModule {}
