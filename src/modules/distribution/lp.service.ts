import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';

@Injectable()
export class LiquidityPoolService {
  private readonly VT_SUPPLY = 1_000_000;
  private readonly ASSETS_OFFERED_PERCENT = 0.99; // % of VT (net of LP) that will be received by Acquirers
  private readonly LP_PERCENT = 0.04; // % of ADA sent by Acquirers to send to LP (should also show LP % of Total Estimated Market Cap)

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>
  ) {}

  /**
   * LP (ADA) = LP % × ADA sent in Acquire Phase (net of fees)
   */
  calculateLpAda(adaSent: number): number {
    return adaSent * this.LP_PERCENT;
  }

  /**
   * VT Price = ADA Acquirers sent / % of assets offered / VT Token Supply
   */
  calculateVtPrice(adaSent: number): number {
    return adaSent / this.ASSETS_OFFERED_PERCENT / this.VT_SUPPLY;
  }

  /**
   * LP (VT) = LP (ADA) / VT Price × LP %
   */
  calculateLpVt(lpAda: number, vtPrice: number): number {
    return (lpAda / vtPrice) * this.LP_PERCENT;
  }

  /**
   * LP (VT/ADA) ratio = Total ADA Sent in Acquire Phase / Total Contributed Asset TVL
   */
  calculateLpVtAdaRatio(totalAdaSent: number, totalAssetTVL: number): number {
    return totalAdaSent / totalAssetTVL;
  }
}
