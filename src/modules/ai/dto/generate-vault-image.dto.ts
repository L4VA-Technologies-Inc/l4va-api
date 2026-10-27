import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export const MAX_IMAGE_PROMPT_LENGTH = 1000;

export class GenerateVaultImageReq {
  @ApiProperty({
    description: 'Image prompt, passed through to the image model as written by the user',
    maxLength: MAX_IMAGE_PROMPT_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(MAX_IMAGE_PROMPT_LENGTH)
  @Expose()
  prompt: string;
}

export class GenerateVaultImageRes {
  @ApiProperty({ description: 'URL of the stored 640x640 WebP image' })
  @Expose()
  fileUrl: string;
}
