import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { User } from 'src/database/user.entity';

/**
 * Custom decorator to extract the authenticated user from the request
 */
export const GetUser = createParamDecorator((data: unknown, ctx: ExecutionContext): User => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
