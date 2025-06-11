import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsNumber, IsOptional, Min } from 'class-validator';

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
