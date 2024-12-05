import { IsString, IsEnum, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class CreateVaultDto {
  @IsString()
  contractAddress: string;

  @IsEnum(['PRIVATE', 'PUBLIC', 'SEMI_PRIVATE'])
  type: 'PRIVATE' | 'PUBLIC' | 'SEMI_PRIVATE';

  @IsEnum(['DRAFT', 'ACTIVE', 'LOCKED', 'TERMINATED'])
  status: 'DRAFT' | 'ACTIVE' | 'LOCKED' | 'TERMINATED';

  @IsOptional()
  @IsString()
  fractionalizationTokenAddress?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  fractionalizationPercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  tokenSupply?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(9)
  tokenDecimals?: number;

  @IsOptional()
  @IsString()
  metadata?: string;
}
