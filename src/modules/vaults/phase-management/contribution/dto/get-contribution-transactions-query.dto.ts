import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class GetContributionTransactionsQueryDto {
  @IsOptional()
  @IsString()
  @IsUUID()
  @ApiProperty({
    description: 'Vault ID to filter transactions',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  vaultId?: string;
}
