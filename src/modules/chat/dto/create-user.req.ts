import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';

export class CreateUserReq {
  @Expose()
  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User name', example: 'John Doe', required: false })
  name?: string;

  @Expose()
  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User image URL', example: 'https://example.com/image.jpg', required: false })
  image?: string;

  @Expose()
  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User role', example: 'user', required: false })
  role?: string;
}
