import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CreateClaimDto {
  @IsString()
  userId: string;

  @IsString()
  type: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  metadata?: Record<string, any>;
}
