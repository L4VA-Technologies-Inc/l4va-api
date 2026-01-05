import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new ForbiddenException('Authorization header missing');
    }

    const token = authHeader.replace('Bearer ', '');
    const adminServiceToken = this.configService.get<string>('ADMIN_SERVICE_TOKEN');

    // Check if it's the service-to-service token
    if (token === adminServiceToken) {
      return true; // Allow Django admin access
    }

    return false; // Deny access for other tokens
  }
}
