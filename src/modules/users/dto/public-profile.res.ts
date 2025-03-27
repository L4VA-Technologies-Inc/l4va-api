import { ApiProperty } from '@nestjs/swagger';
import { FileEntity } from '../../../database/file.entity';
import { LinkEntity } from '../../../database/link.entity';
import {DtoRepresent} from "../../../decorators/dto-represents.decorator";

export class PublicProfileRes {
  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true
  })
  id: string;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true
  })
  name: string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  description?: string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  address:string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? value.url : null,
    expose: { name: 'profileImage' }
  })
  profileImage?: FileEntity;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? value.url : null,
    expose: true
  })
  bannerImage?: FileEntity;

  @ApiProperty({ type: [LinkEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  socialLinks?: LinkEntity[];

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true
  })
  tvl: number;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true
  })
  totalVaults: number;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true
  })
  createdAt: string;

  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true
  })
  updatedAt: string;
}
