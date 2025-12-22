import { ApiProperty } from '@nestjs/swagger';

export class GetVTPriceRes {
  @ApiProperty({ example: 0, description: 'Current asset price' })
  current_price: number;

  @ApiProperty({ example: 0, description: 'Current Total Value Locked (TVL)' })
  current_tvl: number;

  @ApiProperty({ example: 0, description: 'Price change over the last hour' })
  hourly_price_change: number;

  @ApiProperty({ example: 0, description: 'TVL change over the last hour' })
  hourly_tvl_change: number;

  @ApiProperty({ example: 0, description: 'Trading volume over the last hour' })
  hourly_volume: number;

  @ApiProperty({ example: 0, description: 'Price change over the last 24 hours' })
  daily_price_change: number;

  @ApiProperty({ example: 0, description: 'TVL change over the last 24 hours' })
  daily_tvl_change: number;

  @ApiProperty({ example: 0, description: 'Trading volume over the last 24 hours' })
  daily_volume: number;
}

export class GetVTHistoryRes {
  @ApiProperty({ example: 'ok', description: 'Status ("ok" for success, "error" for failure)' })
  s: string;

  @ApiProperty({
    example: [1547942400, 1547942460, 1547942520],
    description: 'Bar timestamps (Unix timestamps in UTC)',
    type: [Number],
  })
  t: number[];

  @ApiProperty({
    example: [3667, 3662.25, 3664.29],
    description: 'Open prices',
    type: [Number],
  })
  o: number[];

  @ApiProperty({
    example: [3667.24, 3664.47, 3664.3],
    description: 'High prices',
    type: [Number],
  })
  h: number[];

  @ApiProperty({
    example: [3661.55, 3661.9, 3662.43],
    description: 'Low prices',
    type: [Number],
  })
  l: number[];

  @ApiProperty({
    example: [3662.25, 3663.13, 3664.01],
    description: 'Close prices',
    type: [Number],
  })
  c: number[];

  @ApiProperty({
    example: [34.7336, 2.4413, 11.7075],
    description: 'Volume data',
    type: [Number],
  })
  v: number[];

  @ApiProperty({
    example: [103000.0, 100000.0, 100000.0],
    description: 'Total Value Locked (optional, if include_tvl=true)',
    type: [Number],
    required: false,
  })
  tvl?: number[];
}

export class GetVTStatisticRes {
  @ApiProperty({ type: GetVTPriceRes, description: 'Current token price data' })
  tokenPrice: GetVTPriceRes;

  @ApiProperty({ type: GetVTHistoryRes, description: 'Token price history data' })
  tokenHistory: GetVTHistoryRes;
}
