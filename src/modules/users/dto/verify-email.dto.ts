import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsHexadecimal, IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token from the verification link' })
  @IsString()
  @IsHexadecimal()
  @Length(64, 64)
  @Expose()
  token: string;
}
