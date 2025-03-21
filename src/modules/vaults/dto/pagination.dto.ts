import { IsNumber, IsOptional, Min } from 'class-validator';
import {Expose, Type} from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class PaginationDto {
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ required: false, minimum: 1, default: 1 })
  @Expose()
  page?: number = 1;

  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ required: false, minimum: 1, default: 10 })
  @Expose()
  limit?: number = 10;
}
