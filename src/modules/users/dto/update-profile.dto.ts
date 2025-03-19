import { IsString, IsOptional, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SocialLinkDto {
  @ApiProperty({
    description: 'Name of the social platform',
    example: 'twitter'
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: 'URL to the social profile',
    example: 'https://twitter.com/username'
  })
  @IsString()
  url: string;
}

export class UpdateProfileDto {
  @ApiProperty({
    description: 'User display name',
    example: 'John Doe',
    required: false
  })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: 'User profile description/bio',
    example: 'Experienced crypto investor and NFT collector',
    required: false
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Profile image file URL (format: image/<file_key>)',
    example: 'image/profile-123.jpg',
    required: false
  })
  @IsString()
  @IsOptional()
  profileImage?: string;

  @ApiProperty({
    description: 'Banner image file URL (format: image/<file_key>)',
    example: 'image/banner-123.jpg',
    required: false
  })
  @IsString()
  @IsOptional()
  bannerImage?: string;

  @ApiProperty({
    description: 'Total Value Locked in user vaults',
    example: 1000000,
    required: false
  })
  @IsNumber()
  @IsOptional()
  tvl?: number;

  @ApiProperty({
    description: 'Total number of vaults owned by user',
    example: 5,
    required: false
  })
  @IsNumber()
  @IsOptional()
  totalVaults?: number;

  @ApiProperty({
    description: 'List of social media links',
    type: [SocialLinkDto],
    required: false
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  @IsOptional()
  socialLinks?: SocialLinkDto[];
}
