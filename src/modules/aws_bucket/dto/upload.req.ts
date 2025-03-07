import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class UploadReq {

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Image file (max 5MB, only image/*)',
  })
  file: ArrayBuffer;
}
