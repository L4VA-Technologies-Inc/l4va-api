import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class MilestoneService {
  private readonly milestones = [10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000];

  constructor(private eventEmitter: EventEmitter2) {}

  checkTVLMilestone(
    vaultId: string,
    vaultName: string,
    previousTVL: number,
    currentTVL: number,
    subscriberIds: string[],
    adaToUsdRate: number
  ): void {
    const reachedMilestone = this.milestones.find(milestone => previousTVL < milestone && currentTVL >= milestone);

    if (reachedMilestone) {
      this.eventEmitter.emit('milestone.tvl_reached', {
        vaultId,
        vaultName,
        milestoneAda: reachedMilestone,
        milestoneUsd: reachedMilestone * adaToUsdRate,
        subscriberIds,
      });
    }
  }

  checkMarketCapMilestone(
    tokenTicker: string,
    previousMarketCap: number,
    currentMarketCap: number,
    tokenHolderIds: string[],
    adaToUsdRate: number
  ): void {
    const reachedMilestone = this.milestones.find(
      milestone => previousMarketCap < milestone && currentMarketCap >= milestone
    );

    if (reachedMilestone) {
      this.eventEmitter.emit('milestone.market_cap_reached', {
        tokenTicker,
        milestoneAda: reachedMilestone,
        milestoneUsd: reachedMilestone * adaToUsdRate,
        tokenHolderIds,
      });
    }
  }
}
