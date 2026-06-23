import { ApiProperty } from '@nestjs/swagger';

export class SystemSettingsResponseDto {
  @ApiProperty({ description: 'Enable or disable protocol fees' })
  protocol_enabled: boolean;

  @ApiProperty({ description: 'VLRM creator fee in basis points' })
  vlrm_creator_fee: number;

  @ApiProperty({ description: 'L4VA monthly budget' })
  l4va_monthly_budget: number;

  @ApiProperty({ description: 'Protocol acquires fee in lovelace' })
  protocol_acquires_fee: number;

  @ApiProperty({ description: 'Enable or disable VLRM creator fee' })
  vlrm_creator_fee_enabled: boolean;

  @ApiProperty({ description: 'Protocol contributors fee in lovelace' })
  protocol_contributors_fee: number;

  @ApiProperty({ description: 'Protocol flat fee in lovelace' })
  protocol_flat_fee: number;

  @ApiProperty({
    description: 'Protocol fee per asset entry (NFT or FT type, quantity ignored) in lovelace (2 ADA = 2000000)',
  })
  protocol_fee_per_asset: number;

  @ApiProperty({
    description: 'LP recommended minimum liquidity in lovelace (500 ADA = 500000000)',
  })
  lp_recommended_min_liquidity: number;
}
