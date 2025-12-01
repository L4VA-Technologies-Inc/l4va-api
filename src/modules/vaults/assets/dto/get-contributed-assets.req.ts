import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class GetContributedAssetsReq {
  @Expose()
  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'Search term for filtering assets', example: 'NFT', required: false })
  search?: string;

  @Expose()
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Page number', example: 1, default: 1 })
  page: number;

  @Expose()
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Items per page', example: 10, default: 10 })
  limit: number;
}
