import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { User } from '@/database/user.entity';

export class UploadImageRes {
  @Expose()
  @ApiProperty({ description: 'Updated user entity', type: User })
  user: User;
}
