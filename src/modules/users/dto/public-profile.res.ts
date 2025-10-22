import { ApiProperty } from '@nestjs/swagger';

import { DtoRepresent } from '../../../decorators/dto-represents.decorator';

import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';

export class PublicProfileRes {
  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  id: string;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  name: string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  description?: string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  address: string;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  email: string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? value.url : null),
    expose: { name: 'profileImage' },
  })
  profileImage?: FileEntity;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? value.url : null),
    expose: true,
  })
  bannerImage?: FileEntity;

  @ApiProperty({ type: [LinkEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  socialLinks?: LinkEntity[];

  @ApiProperty({ description: 'Total value of all assets in ADA' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'totalValueAda' },
  })
  totalValueAda: number;

  @ApiProperty({ description: 'Total value of all assets in USD' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'totalValueUsd' },
  })
  totalValueUsd: number;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  totalVaults: number;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  createdAt: string;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  updatedAt: string;
}
