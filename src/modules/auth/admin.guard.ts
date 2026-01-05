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

    const token = authHeader.replace('Bearer ', '').trim();
    const adminServiceToken = this.configService.get<string>('ADMIN_SERVICE_TOKEN');

    // Security check: Ensure token is configured and not empty
    if (!adminServiceToken || adminServiceToken.trim() === '') {
      throw new ForbiddenException('Admin service token not configured');
    }

    // Security check: Ensure provided token is not empty
    if (!token || token === '') {
      throw new ForbiddenException('Invalid authorization token');
    }

    // Check if it's the service-to-service token
    if (token === adminServiceToken) {
      return true; // Allow Django admin access
    }

    throw new ForbiddenException('Access denied: Invalid admin credentials');
  }
}
