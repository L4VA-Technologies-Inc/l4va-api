import { ApiProperty } from '@nestjs/swagger';
import { FileEntity } from '../../../database/file.entity';
import { LinkEntity } from '../../../database/link.entity';

export class PublicProfileRes {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false })
  description?: string;

  @ApiProperty({ required: false })
  profileImage?: FileEntity;

  @ApiProperty({ required: false })
  bannerImage?: FileEntity;

  @ApiProperty({ type: [LinkEntity], required: false })
  socialLinks?: LinkEntity[];

  @ApiProperty()
  tvl: number;

  @ApiProperty()
  totalVaults: number;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
