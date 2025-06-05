import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class VoteReq {
  @ApiProperty({
    description: 'Selected voting option',
    example: 'Yes',
  })
  @IsNotEmpty()
  @IsString()
  option: string;

  @ApiProperty({
    description: 'Optional reason for the vote',
    required: false,
    example: 'I support this proposal because...',
  })
  @IsString()
  reason?: string;
}
