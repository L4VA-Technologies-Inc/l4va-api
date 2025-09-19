import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VoteReq {
  @ApiProperty({
    description: 'ID of the voting option',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsNotEmpty()
  @IsString()
  voteOptionId: string;

  @ApiProperty({
    description: "The voter's Cardano address",
    example: 'addr_test1qpjavyk....nw8s46zete',
  })
  @IsNotEmpty()
  @IsString()
  voterAddress: string;
}
