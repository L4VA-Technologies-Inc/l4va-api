import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

import { VoteType } from '@/types/vote.types';

export class VoteDetailDto {
  @Expose()
  @ApiProperty({ description: 'Vote ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Proposal ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  proposalId: string;

  @Expose()
  @ApiProperty({ description: 'Voter user ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  voterId: string;

  @Expose()
  @ApiProperty({ description: 'Voter wallet address', example: 'addr1q934ccfkwy292....' })
  voterAddress: string;

  @Expose()
  @ApiProperty({ description: 'Vote weight based on token holdings', example: '1000000' })
  voteWeight: string;

  @Expose()
  @ApiProperty({ description: 'Vote type', enum: VoteType, example: VoteType.YES })
  vote: VoteType;

  @Expose()
  @ApiProperty({ description: 'Vote timestamp', example: '2023-08-15T10:30:00Z' })
  timestamp: Date;
}

export class VoteRes {
  @Expose()
  @ApiProperty({ description: 'Whether the vote was successful', example: true })
  success: boolean;

  @Expose()
  @ApiProperty({ description: 'Response message', example: 'Vote recorded successfully' })
  message: string;

  @Expose()
  @ApiProperty({ description: 'Vote details', type: VoteDetailDto })
  @Type(() => VoteDetailDto)
  vote: VoteDetailDto;
}
