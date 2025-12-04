import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class GetVotingPowerRes {
  @Expose()
  @ApiProperty({ description: 'User voting power as a string', example: '1000000' })
  votingPower: string;
}
