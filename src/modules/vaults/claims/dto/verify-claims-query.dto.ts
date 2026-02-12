import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class VerifyClaimsQueryDto {
  @ApiPropertyOptional({
    description: 'Filter results by user address (partial match supported)',
  })
  @IsOptional()
  @IsString()
  userAddress?: string;

  @ApiPropertyOptional({
    description: 'Filter results by user ID',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
