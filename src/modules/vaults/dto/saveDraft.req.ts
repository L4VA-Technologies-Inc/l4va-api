import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type, plainToInstance } from 'class-transformer';
import { IsArray, IsEnum, IsNumber, IsObject, IsOptional, IsString, ValidateIf, Min, Max } from 'class-validator';

import {
  ContributionWindowType,
  InvestmentWindowType,
  TerminationType,
  ValueMethod,
  VaultPrivacy,
  VaultType,
} from '../../../types/vault.types';
import { AssetWhitelist, ContributorWhitelist, AcquirerWhitelist, AcquirerWhitelistCsv, SocialLink } from '../types';

import { TagDto } from './tag.dto';

export class SaveDraftReq {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  id?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  name?: string | null;

  @ApiProperty({ required: false, nullable: true, enum: VaultType })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsEnum(VaultType)
  @Expose()
  type?: VaultType | null;

  @ApiProperty({ required: false, nullable: true, enum: VaultPrivacy })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsEnum(VaultPrivacy)
  @Expose()
  privacy?: VaultPrivacy | null;

  @ApiProperty({
    description: 'Valuation type - public vaults can only use LBE, private/semi-private can use LBE or fixed',
    enum: ValueMethod,
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsEnum(ValueMethod)
  @Expose()
  valueMethod?: ValueMethod | null;

  @ApiProperty({
    description: 'Currency for fixed valuation (required when valueMethod is fixed)',
    required: false,
    nullable: true,
    example: 'ADA',
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  valuationCurrency?: string | null;

  @ApiProperty({
    description: 'Amount for fixed valuation (required when valueMethod is fixed)',
    required: false,
    nullable: true,
    example: '1000000',
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  valuationAmount?: string | null;

  @ApiProperty({ required: false, nullable: true, enum: ContributionWindowType })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsEnum(ContributionWindowType)
  @Expose()
  contributionOpenWindowType?: ContributionWindowType | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  contributionOpenWindowTime?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  description?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  bannerUrl?: string | null;

  @ApiProperty({
    description: 'CSV file containing acquirer whitelist',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @Expose()
  acquirerWhitelistCsv?: AcquirerWhitelistCsv | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Duration in milliseconds',
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  contributionDuration?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Duration in milliseconds',
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  acquireWindowDuration?: number | null;

  @ApiProperty({ required: false, nullable: true, enum: InvestmentWindowType })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsEnum(InvestmentWindowType)
  @Expose()
  acquireOpenWindowType?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  acquireOpenWindowTime?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  tokensForAcquires?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  acquireReserve?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  liquidityPoolContribution?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  ftTokenSupply?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  vaultTokenTicker?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  ftTokenDecimals?: number | null;

  @ApiProperty({ required: false, nullable: true, enum: TerminationType })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsEnum(TerminationType)
  @Expose()
  terminationType?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Duration in milliseconds',
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Expose()
  timeElapsedIsEqualToTime?: number | null;

  @ApiProperty({
    description: 'Vault appreciation percentage (between 0.00 and 100.00)',
    required: false,
    nullable: true,
    minimum: 0,
    maximum: 100,
    type: Number,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  vaultAppreciation?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Threshold value between 0.00 and 100.00',
    minimum: 0,
    maximum: 100,
    type: Number,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  creationThreshold?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Threshold value between 0.00 and 100.00',
    minimum: 0,
    maximum: 100,
    type: Number,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  startThreshold?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Threshold value between 0.00 and 100.00',
    minimum: 0,
    maximum: 100,
    type: Number,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  voteThreshold?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Threshold value between 0.00 and 100.00',
    minimum: 0,
    maximum: 100,
    type: Number,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  executionThreshold?: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Threshold value between 0.00 and 100.00',
    minimum: 0,
    maximum: 100,
    type: Number,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  cosigningThreshold?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  vaultImage?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  bannerImage?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsString()
  @Expose()
  ftTokenImg?: string | null;

  @ApiProperty({ required: false, nullable: true, type: [AssetWhitelist] })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsArray()
  @Type(() => AssetWhitelist)
  @Expose()
  assetsWhitelist?: AssetWhitelist[] | null;

  @ApiProperty({ required: false, nullable: true, type: [AcquirerWhitelist] })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsArray()
  @Type(() => AcquirerWhitelist)
  @Expose()
  acquirerWhitelist?: AcquirerWhitelist[] | null;

  @ApiProperty({
    description: 'List of contributor wallet addresses (required for private vaults)',
    type: [ContributorWhitelist],
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsArray()
  @Type(() => ContributorWhitelist)
  @Expose()
  whitelistContributors?: ContributorWhitelist[] | null;

  @ApiProperty({ required: false, nullable: true, type: [SocialLink] })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsArray()
  @Type(() => SocialLink)
  @Expose()
  socialLinks?: SocialLink[] | null;

  @ApiProperty({
    description: 'List of tags for the vault',
    type: [TagDto],
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o, v) => v !== null)
  @IsArray()
  @Type(() => TagDto)
  @Expose()
  tags?: TagDto[] | null;
}
