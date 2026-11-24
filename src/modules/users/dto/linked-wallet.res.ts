import { ApiProperty } from '@nestjs/swagger';

import { ChainType } from '@/types/vault.types';

export class LinkedWalletRes {
  @ApiProperty({ description: 'User id of the linked wallet' })
  userId: string;

  @ApiProperty({ description: 'Wallet address' })
  address: string;

  @ApiProperty({ enum: ChainType })
  chainType: ChainType;

  @ApiProperty({ description: 'True for the wallet of the authenticated session' })
  isCurrent: boolean;
}
