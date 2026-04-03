import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DexHunterService } from '../dexhunter/dexhunter.service';
import { WayUpPricingService } from '../wayup/wayup-pricing.service';

import { TokenVerification, VerificationPlatform } from '@/database/token-verification.entity';

const BATCH_SIZE = 100;

@Injectable()
export class TokenVerificationRefreshService {
  private readonly logger = new Logger(TokenVerificationRefreshService.name);
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(TokenVerification)
    private readonly tokenVerificationRepo: Repository<TokenVerification>,
    private readonly dexHunterService: DexHunterService,
    private readonly wayUpPricingService: WayUpPricingService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  @Cron(process.env.TOKEN_VERIFICATION_REFRESH_CRON ?? CronExpression.EVERY_HOUR)
  async refreshUnverifiedTokens(): Promise<void> {
    if (!this.isMainnet) {
      return;
    }

    const pending = await this.tokenVerificationRepo.find({
      where: { is_verified: false },
      order: { updated_at: 'ASC' },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) {
      return;
    }

    this.logger.log(`Token verification refresh: checking ${pending.length} unverified policies`);

    let updated = 0;
    for (const row of pending) {
      try {
        if (await this.tryRefreshRow(row)) {
          updated++;
        }
      } catch (err) {
        this.logger.warn(
          `Token verification refresh failed for policy ${row.policy_id}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    if (updated > 0) {
      this.logger.log(`Token verification refresh: updated ${updated} row(s)`);
    }
  }

  private async tryRefreshRow(row: TokenVerification): Promise<boolean> {
    const prev = {
      is_verified: row.is_verified,
      collection_name: row.collection_name,
      platform: row.platform,
      token_id: row.token_id,
    };

    const policyId = row.policy_id;
    const tokenIdForDex = row.token_id ?? policyId;

    const dexHunterData = await this.dexHunterService.fetchTokenVerification(tokenIdForDex);
    if (dexHunterData !== null) {
      row.token_id = tokenIdForDex;
      row.collection_name = dexHunterData.collectionName;
      row.is_verified = dexHunterData.isVerified;
      row.platform = VerificationPlatform.DEXHUNTER;
      if (this.hasChanged(prev, row)) {
        await this.tokenVerificationRepo.save(row);
        return true;
      }
      return false;
    }

    try {
      const wayupData = await this.fetchWayupCollectionInfo(policyId);
      if (!wayupData.hasResults) {
        return false;
      }
      row.collection_name = wayupData.collectionName;
      row.is_verified = wayupData.isVerified;
      row.platform = VerificationPlatform.WAYUP;
      if (this.hasChanged(prev, row)) {
        await this.tokenVerificationRepo.save(row);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        `WayUp token verification refresh for policy ${policyId}: ${error instanceof Error ? error.message : error}`
      );
      return false;
    }
  }

  private hasChanged(
    prev: {
      is_verified: boolean;
      collection_name: string | null;
      platform: VerificationPlatform | null;
      token_id: string | null;
    },
    row: TokenVerification
  ): boolean {
    return (
      prev.is_verified !== row.is_verified ||
      prev.collection_name !== row.collection_name ||
      prev.platform !== row.platform ||
      prev.token_id !== row.token_id
    );
  }

  private async fetchWayupCollectionInfo(policyId: string): Promise<{
    collectionName: string | null;
    isVerified: boolean;
    hasResults: boolean;
  }> {
    const response = await this.wayUpPricingService.getCollectionAssets({ policyId });
    const firstAsset = response.results?.[0];
    const hasResults = Array.isArray(response.results) && response.results.length > 0;
    const collectionName = firstAsset?.collection?.name || firstAsset?.attributes?.['Ticker'] || null;
    const isVerified: boolean = firstAsset?.collection?.verified || false;
    return { collectionName, isVerified, hasResults };
  }
}
