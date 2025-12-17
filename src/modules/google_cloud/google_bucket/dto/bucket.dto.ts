import { IsEnum, IsOptional } from 'class-validator';

export enum ImageType {
  BACKGROUND = 'background',
  TICKER = 'ticker',
}

export class UploadImageDto {
  @IsOptional()
  @IsEnum(ImageType)
  imageType?: ImageType;
}

// Keep alias for backward compatibility
export const AwsUploadImageDto = UploadImageDto;

interface ImageResizeParams {
  width: number;
  height: number;
}

export const ImageResizeMap: Record<ImageType, ImageResizeParams> = {
  [ImageType.BACKGROUND]: { width: 640, height: 640 },
  [ImageType.TICKER]: { width: 256, height: 256 },
};
