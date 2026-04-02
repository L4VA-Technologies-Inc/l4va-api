import { ApiProperty } from '@nestjs/swagger';

export class StakedBoxItem {
  @ApiProperty({ description: 'Transaction hash of the UTxO' })
  txHash: string;

  @ApiProperty({ description: 'Output index of the UTxO' })
  outputIndex: number;

  @ApiProperty({ description: 'Full Cardano asset unit (policyId + hex-encoded asset name)' })
  unit: string;

  @ApiProperty({ description: 'Policy id (first 56 hex chars of unit)' })
  policyId: string;

  @ApiProperty({ description: 'Human-readable amount of tokens locked in this box (e.g. 100.56)', example: 100.56 })
  stakedAmount: number;

  @ApiProperty({ description: 'Timestamp (ms) when the tokens were staked' })
  stakedAt: number;

  @ApiProperty({ description: 'Estimated reward accrued so far, human-readable (e.g. 1.23)', example: 1.23 })
  estimatedReward: number;

  @ApiProperty({
    description: 'Estimated total payout (deposit + reward), human-readable (e.g. 101.79)',
    example: 101.79,
  })
  estimatedPayout: number;

  @ApiProperty({ description: 'Whether this box has passed verification and cooldown — can be unstaked' })
  eligible: boolean;

  @ApiProperty({ description: 'Timestamp (ms) when the cooldown period ends' })
  cooldownEndsAt: number;
}

export class StakedBalanceRes {
  @ApiProperty({
    description: 'Individual staked UTxO boxes owned by the user',
    type: [StakedBoxItem],
  })
  boxes: StakedBoxItem[];
}
