import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class VaultStatisticsResponse {
  @ApiProperty({
    description: 'Number of active vaults (published, contribution, acquire, locked)',
    example: 42,
  })
  @Expose()
  activeVaults: number;

  @ApiProperty({
    description: 'Total number of vaults ever created',
    example: 85,
  })
  @Expose()
  totalVaults: number;

  @ApiProperty({
    description: 'Total value of locked vaults in USD',
    example: 1250000,
  })
  @Expose()
  totalValueUsd: number;

  @ApiProperty({
    description: 'Total value of locked vaults in ADA',
    example: 3500000,
  })
  @Expose()
  totalValueAda: number;

  @ApiProperty({
    description: 'Total number of contributed assets across all vaults',
    example: 750,
  })
  @Expose()
  totalContributed: number;

  @ApiProperty({
    description: 'Total number of assets ever contributed to any vault',
    example: 1200,
  })
  @Expose()
  totalAssets: number;

  @ApiProperty({
    description: 'Total ADA value ever acquired across all vaults',
    example: 5000000,
  })
  @Expose()
  totalAcquiredAda: number;

  @ApiProperty({
    description: 'Total USD value ever acquired across all vaults',
    example: 1750000,
  })
  @Expose()
  totalAcquiredUsd: number;

  @ApiProperty({
    description: 'Distribution of vaults by stage (draft, contribution, acquire, locked, terminated)',
    example: {
      draft: {
        percentage: 10,
        valueAda: 2500000,
        valueUsd: 875000,
      },
    },
  })
  @Expose()
  vaultsByStage: Record<
    string,
    {
      percentage: number;
      valueAda: number;
      valueUsd: number;
    }
  >;

  @ApiProperty({
    description: 'Distribution of vaults by privacy type (private, semi-private, public)',
    example: {
      private: {
        percentage: 30.33,
        valueAda: 7582500,
        valueUsd: 2653875,
      },
      semiPrivate: {
        percentage: 26,
        valueAda: 6500000,
        valueUsd: 2275000,
      },
      public: {
        percentage: 43.67,
        valueAda: 10917500,
        valueUsd: 3821125,
      },
    },
  })
  @Expose()
  vaultsByType: Record<
    string,
    {
      percentage: number;
      valueAda: number;
      valueUsd: number;
    }
  >;
}
