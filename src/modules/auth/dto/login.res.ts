import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class LoginUserDto {
  @Expose()
  @ApiProperty({ description: 'User ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'User name', example: 'John Doe' })
  name: string;

  @Expose()
  @ApiProperty({ description: 'Wallet address', example: 'addr1q934ccfkwy292....' })
  address: string;

  @Expose()
  @ApiProperty({ description: 'User description', required: false, example: 'Experienced crypto investor' })
  description?: string;

  @Expose()
  @ApiProperty({ description: 'Total value in USD', example: 1000000 })
  totalValueUsd: number;

  @Expose()
  @ApiProperty({ description: 'Total value in ADA', example: 3500000 })
  totalValueAda: number;

  @Expose()
  @ApiProperty({ description: 'Total number of vaults', example: 5 })
  totalVaults: number;

  @Expose()
  @ApiProperty({ description: 'User gains', required: false, example: 15000 })
  gains?: number;

  @Expose()
  @ApiProperty({ description: 'Profile image URL', required: false, example: 'image/profile-123.jpg' })
  profileImage?: string;

  @Expose()
  @ApiProperty({ description: 'Banner image URL', required: false, example: 'image/banner-123.jpg' })
  bannerImage?: string;

  @Expose()
  @ApiProperty({ description: 'User email', required: false, example: 'user@example.com' })
  email?: string;
}

export class LoginRes {
  @Expose()
  @ApiProperty({ description: 'Whether authentication was successful', example: true })
  success: boolean;

  @Expose()
  @ApiProperty({ description: 'Authentication message', example: '✅ Authentication success!' })
  message: string;

  @Expose()
  @ApiProperty({ description: 'JWT access token', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken?: string;

  @Expose()
  @ApiProperty({ description: 'User information', type: LoginUserDto, required: false })
  user?: LoginUserDto;
}
