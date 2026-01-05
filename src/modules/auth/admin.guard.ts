import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    const adminAddress = this.configService.get<string>('ADMIN_ADDRESS');

    if (!adminAddress) {
      throw new ForbiddenException('Admin address not configured');
    }

    // Check if user's address matches admin address
    if (user.address !== adminAddress) {
      throw new ForbiddenException('Access denied: Admin privileges required');
    }

    return true;
  }
}
