import { ApiProperty } from '@nestjs/swagger';
import { FileEntity } from '../../../database/file.entity';
import { LinkEntity } from '../../../database/link.entity';
import {Expose, Transform} from "class-transformer";

export class PublicProfileRes {
  @ApiProperty()
  @Expose()
  id: string;

  @ApiProperty()
  @Expose()
  name: string;

  @ApiProperty({ required: false })
  @Expose()
  description?: string;

  @ApiProperty({ required: false })
  @Expose({ name: 'profileImage'})
  @Transform(({ value }) => value ? value.url : null)
  profileImage?: FileEntity;

  @ApiProperty({ required: false })
  @Expose()
  @Transform(({value }) => value ? value.url : null )
  bannerImage?: FileEntity;

  @ApiProperty({ type: [LinkEntity], required: false })
  @Expose()
  socialLinks?: LinkEntity[];

  @ApiProperty()
  @Expose()
  tvl: number;

  @ApiProperty()
  @Expose()
  totalVaults: number;

  @ApiProperty()
  @Expose()
  createdAt: string;

  @ApiProperty()
  @Expose()
  updatedAt: string;
}
