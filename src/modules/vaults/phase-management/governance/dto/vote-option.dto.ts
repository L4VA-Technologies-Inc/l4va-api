import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class VoteOptionDto {
  @ApiProperty({
    description: 'Label for the voting option',
    example: 'Increase allocation by 10%',
  })
  @IsNotEmpty()
  @IsString()
  label: string;

  @ApiProperty({
    description: 'Display order for the option',
    required: false,
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  order?: number;
}
