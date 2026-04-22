import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';

/**
 * WalletOwnershipGuard
 *
 * Ensures that the authenticated user can only access resources for their own wallet address.
 * This guard should be used AFTER AuthGuard to verify that the wallet address in the route
 * parameter matches the wallet address in the JWT token.
 *
 * Usage:
 * @UseGuards(AuthGuard, WalletOwnershipGuard)
 * @Get('score/:walletAddress')
 *
 * The guard will:
 * 1. Extract the walletAddress from route params
 * 2. Compare it with the address in the JWT payload (request.user.address)
 * 3. Allow access if they match (case-insensitive)
 * 4. Throw ForbiddenException if they don't match
 */
@Injectable()
export class WalletOwnershipGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request['user'];

    // Extract wallet address from route params
    const requestedWalletAddress = request.params?.walletAddress;

    if (!requestedWalletAddress) {
      // If there's no walletAddress param, this guard doesn't apply
      return true;
    }

    if (!user?.address) {
      throw new ForbiddenException('User address not found in token');
    }

    // Compare addresses (case-insensitive for Cardano addresses)
    const userAddress = user.address.toLowerCase();
    const paramAddress = requestedWalletAddress.toLowerCase();

    if (userAddress !== paramAddress) {
      throw new ForbiddenException('You can only access information for your own wallet address');
    }

    return true;
  }
}
