import { ApiProperty } from '@nestjs/swagger';

import { DtoRepresent } from '../../../decorators/dto-represents.decorator';

import { PublicProfileRes } from './public-profile.res';

/** The signed-in user's own profile: the public profile plus private account fields. */
export class OwnProfileRes extends PublicProfileRes {
  @ApiProperty()
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  email: string;

  @ApiProperty({ required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  emailVerified?: boolean;
}
