import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum } from 'class-validator';

export enum ImageType {
  AVATAR = 'avatar',
  BANNER = 'banner',
}

export class UploadProfileImageDto {
  @ApiProperty({
    example: 'avatar',
    required: false,
    enum: ImageType,
  })
  @IsString()
  @IsEnum(ImageType)
  imageType: ImageType;

  @ApiProperty({ type: 'string', format: 'binary' })
  image: any;
}
