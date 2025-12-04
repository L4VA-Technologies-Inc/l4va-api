import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CreateUserRes {
  @Expose()
  @ApiProperty({
    description: 'User object from Stream Chat',
    type: Object,
    additionalProperties: true,
    example: {
      id: 'user123',
      name: 'John Doe',
      image: 'https://example.com/image.jpg',
      role: 'user',
    },
  })
  user: Record<string, unknown>;

  @Expose()
  @ApiProperty({ description: 'Whether the operation was successful', example: true })
  success: boolean;
}
