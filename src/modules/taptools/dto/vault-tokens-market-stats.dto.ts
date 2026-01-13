import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class VaultTokensMarketStatsDto {
  @ApiProperty({ description: 'Token unit identifier' })
  @Expose()
  unit: string;

  @ApiProperty({ description: 'Circulating supply' })
  @Expose()
  circSupply: number;

  @ApiProperty({ description: 'Fully diluted valuation' })
  @Expose()
  fdv: number;

  @ApiProperty({ description: 'Market capitalization' })
  @Expose()
  mcap: number;

  @ApiProperty({ description: 'Token price' })
  @Expose()
  price: number;

  @ApiProperty({ description: 'Token ticker symbol' })
  @Expose()
  ticker: string;

  @ApiProperty({ description: 'Total supply' })
  @Expose()
  totalSupply: number;

  @ApiProperty({ description: 'Price change in 1 hour' })
  @Expose()
  price_change_1h: number;

  @ApiProperty({ description: 'Price change in 24 hours' })
  @Expose()
  price_change_24h: number;

  @ApiProperty({ description: 'Price change in 7 days' })
  @Expose()
  price_change_7d: number;

  @ApiProperty({ description: 'Price change in 30 days' })
  @Expose()
  price_change_30d: number;

  @ApiProperty({ description: 'Token image URL', required: false })
  @Expose()
  image?: string;

  @ApiProperty({ description: 'Total Value Locked' })
  @Expose()
  tvl: number;
}
