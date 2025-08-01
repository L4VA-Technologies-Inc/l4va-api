import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

import { VoteType } from '@/types/vote.types';

export class VoteReq {
  @ApiProperty({
    description: 'Selected voting option',
    example: 'yes',
    enum: VoteType,
  })
  @IsNotEmpty()
  @IsEnum(VoteType)
  vote: VoteType;

  @ApiProperty({
    description: "The voter's Cardano address",
    example: 'addr_test1qpjavyk....nw8s46zete',
  })
  @IsNotEmpty()
  @IsString()
  voterAddress: string;

  @ApiProperty({
    description: 'Optional reason for the vote',
    required: false,
    example: 'I support this proposal because...',
  })
  @IsString()
  reason?: string;
}
