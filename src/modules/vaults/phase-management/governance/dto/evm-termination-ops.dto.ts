import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEthereumAddress, IsOptional } from 'class-validator';

/** Body for the per-asset termination operations (defer / resume / sweep). */
export class EvmTerminationAssetDto {
  @ApiProperty({
    description: 'The committed distributable asset to act on. Use the zero address for native ETH.',
    example: '0x4cC5Ef15C13708CE34A9B9b9e14e8dbfd1a31076',
  })
  @IsEthereumAddress()
  asset!: string;
}

/** Body for `redeemFor` — an operator-pushed redemption for an inactive holder. */
export class EvmRedeemForDto {
  @ApiProperty({
    description: 'The VT holder to redeem for. The payout goes strictly to this address.',
    example: '0x42b010e2590e2AAa379B9E852b34C390d73E66a1',
  })
  @IsEthereumAddress()
  holder!: string;
}

/** Body for `retryTermination` — resume a commit that stalled after preparing. */
export class EvmRetryTerminationDto {
  @ApiPropertyOptional({
    description:
      'Assets to waive (route to the treasury at the deadline instead of distributing). Only honoured when ' +
      'evm_termination_allow_waivers is enabled; otherwise the call is rejected.',
    type: [String],
    example: [],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsEthereumAddress({ each: true })
  waived?: string[];
}
