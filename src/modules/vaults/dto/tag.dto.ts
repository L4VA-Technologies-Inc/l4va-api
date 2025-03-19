import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { Expose } from 'class-transformer';

export class TagDto {
  @ApiProperty({
    description: 'Name of the tag',
    example: 'NFT'
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  name: string;

  constructor(partial: Partial<TagDto>) {
    Object.assign(this, partial);
  }
}
