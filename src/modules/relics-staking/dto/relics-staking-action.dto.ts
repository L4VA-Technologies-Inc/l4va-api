import { IsEnum, IsArray, IsBoolean, IsNumber, IsString, IsOptional, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum RelicsStakingAction {
  STAKE = 'stake',
  UNSTAKE = 'unstake',
}

export class RelicsStakingActionDto {
  @ApiProperty({
    enum: RelicsStakingAction,
    description: 'Action type: stake or unstake',
    example: RelicsStakingAction.STAKE,
  })
  @IsEnum(RelicsStakingAction)
  action: RelicsStakingAction;

  @ApiProperty({
    description: 'Asset IDs to stake (for stake action). Empty if stakeAll is true',
    example: ['asset-uuid-1', 'asset-uuid-2'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assetIds?: string[];

  @ApiProperty({
    description: 'Stake all eligible NFTs (for stake action)',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stakeAll?: boolean;

  @ApiProperty({
    description: 'Stake IDs to unstake (for unstake action)',
    example: ['12345', '67890'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  stakeIds?: string[];

  @ApiProperty({
    description: 'Claim rewards when unstaking',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  claimRewards?: boolean;

  @ApiProperty({
    description: 'Stake collection ID (default: 54 for Relics)',
    example: 54,
    default: 54,
  })
  @IsOptional()
  @IsNumber()
  stakeCollectionId?: number;

  @ApiProperty({
    description: 'Staking platform identifier',
    example: 'anvil-relics',
    default: 'anvil-relics',
  })
  @IsOptional()
  @IsString()
  platform?: string;
}
