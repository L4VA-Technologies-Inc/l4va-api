import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { ImageType } from '@/modules/google_cloud/google_bucket/dto/bucket.dto';

export { ImageType };

export class UploadProfileImageDto {
  @ApiProperty({
    example: 'avatar',
    required: false,
    enum: ImageType,
    description: 'Defaults to avatar if omitted. Use avatar or banner for profile images.',
  })
  @IsOptional()
  @IsEnum(ImageType)
  imageType?: ImageType;

  @ApiProperty({ type: 'string', format: 'binary' })
  image: any;
}
