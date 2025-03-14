import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class TagDto {
  @ApiProperty({
    description: 'Name of the tag',
    example: 'NFT'
  })
  @IsNotEmpty()
  @IsString()
  name: string;
}
