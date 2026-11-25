import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** A token index vaults can trade today; one row of the public /supported-tokens page. */
export interface SupportedToken {
  address: string;
  symbol: string;
  name: string;
  /** Trust category from swap-token-report.ts, e.g. "RWA - Robinhood stock token", "Stablecoin". */
  category: string;
  /** good: round trip within the approve limit at the reference size; thin: small vaults only. */
  liquidity: 'good' | 'thin';
  /** Buy with ETH and sell straight back at `refEth`, in bps (null: no route at that size). */
  roundTripLossBps: number | null;
  checkedAt: string;
}

export interface SupportedTokensRes {
  updatedAt: string | null;
  refEth: string;
  tokens: SupportedToken[];
}

export class SupportedTokenInput {
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  address: string;

  @IsString()
  @MaxLength(64)
  symbol: string;

  @IsString()
  @MaxLength(256)
  name: string;

  @IsString()
  @MaxLength(64)
  category: string;

  @IsIn(['good', 'thin'])
  liquidity: 'good' | 'thin';

  @IsOptional()
  @IsInt()
  roundTripLossBps: number | null;

  @IsArray()
  @ArrayMaxSize(64)
  @Matches(/^0x[0-9a-fA-F]{64}$/, { each: true })
  poolIds: string[];

  @IsDateString()
  checkedAt: string;
}

/** Body of the admin PUT: replaces the whole list of the API's chain. */
export class ReplaceSupportedTokensReq {
  @Matches(/^\d+(\.\d+)?$/)
  refEth: string;

  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => SupportedTokenInput)
  tokens: SupportedTokenInput[];
}
