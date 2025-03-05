import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class LoginReq {

  @IsNotEmpty()
  @ApiProperty()
  signature: any;

  @IsNotEmpty()
  @ApiProperty()
  stakeAddress: string;
}
