import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateSystemSettingsDto {
  @ApiProperty({
    description: 'Enable or disable protocol fees',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  protocol_enabled?: boolean;

  @ApiProperty({
    description: 'VLRM creator fee in basis points',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  vlrm_creator_fee?: number;

  @ApiProperty({ description: 'L4VA monthly budget', required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  l4va_monthly_budget?: number;

  @ApiProperty({
    description: 'Protocol acquires fee in lovelace',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  protocol_acquires_fee?: number;

  @ApiProperty({
    description: 'Enable or disable VLRM creator fee',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  vlrm_creator_fee_enabled?: boolean;

  @ApiProperty({
    description: 'Protocol contributors fee in lovelace',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  protocol_contributors_fee?: number;

  @ApiProperty({
    description: 'Protocol flat fee in lovelace',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  protocol_flat_fee?: number;

  @ApiProperty({
    description: 'LP recommended minimum liquidity in lovelace (500 ADA = 500000000)',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  lp_recommended_min_liquidity?: number;
}
