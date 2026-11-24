import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

export class TickerAvailabilityQuery {
  @ApiProperty({ example: 'LAVA' })
  @IsString()
  @MaxLength(9)
  @Matches(/^[A-Za-z0-9]+$/)
  @Expose()
  ticker: string;
}

export class TickerAvailabilityRes {
  @ApiProperty({ description: 'False when another active vault already uses this ticker' })
  available: boolean;

  @ApiProperty({ nullable: true, description: 'First free numbered variant when the ticker is taken' })
  suggestion: string | null;
}
