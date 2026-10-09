import { ApiProperty } from '@nestjs/swagger';

export class FaucetTokenRes {
  @ApiProperty({ description: 'Token contract address', example: '0x32888564d0AEf1416B4153791c8F111b58000cA0' })
  address: string;

  @ApiProperty({ description: 'Token symbol', example: 'tTSLA' })
  symbol: string;

  @ApiProperty({ description: 'Whole tokens sent per claim', example: 1000 })
  amount: number;
}

export class FaucetStatusRes {
  @ApiProperty({ description: 'Whether the faucet is available on this environment' })
  enabled: boolean;

  @ApiProperty({ type: [FaucetTokenRes] })
  tokens: FaucetTokenRes[];

  @ApiProperty({ description: 'Hours between claims per wallet', example: 24 })
  cooldownHours: number;

  @ApiProperty({ description: 'Unix ms when the caller can claim again; null when they can claim now', nullable: true })
  nextClaimAt: number | null;
}

export class FaucetClaimRes {
  @ApiProperty({ description: 'Recipient wallet' })
  address: string;

  @ApiProperty({ description: 'Mint transactions, one per token' })
  transactions: Array<{ token: string; symbol: string; txHash: string }>;

  @ApiProperty({ description: 'Unix ms when the wallet can claim again' })
  nextClaimAt: number;
}
