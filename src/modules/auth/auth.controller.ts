import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';

import { AuthService } from './auth.service';
import { CardanoChallengeReq, EvmChallengeReq, LoginReq } from './dto/login.req';
import { LoginRes } from './dto/login.res';

import { ApiDoc } from '@/decorators/api-doc.decorator';

/**
 * Client IP behind Cloudflare/nginx (the app does not set trust proxy, so req.ip is the proxy).
 * Only used to throttle challenge requests; a spoofed header just changes which bucket is hit.
 */
const clientIp = (req: Request): string | undefined => {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  };
  const forwarded = header('x-forwarded-for')?.split(',');
  return header('cf-connecting-ip') ?? header('x-real-ip') ?? forwarded?.[forwarded.length - 1]?.trim() ?? req.ip;
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @ApiDoc({
    summary: 'Login user',
    description: 'User login successful',
    status: 200,
  })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiResponse({ type: LoginRes, status: 200 })
  async login(@Body() body: LoginReq): Promise<LoginRes> {
    return this.authService.login(body);
  }

  @ApiDoc({
    summary: 'Get an EVM login message',
    description:
      'Returns a single-use EIP-4361 (Sign-In with Ethereum) message bound to the calling origin; the wallet must ' +
      'personal_sign it and send the signature to /auth/login as evmSignature',
    status: 200,
  })
  @HttpCode(HttpStatus.OK)
  @Post('evm/challenge')
  async evmChallenge(
    @Body() body: EvmChallengeReq,
    @Req() req: Request,
    @Headers('origin') origin?: string
  ): Promise<{ message: string }> {
    await this.authService.assertChallengeRateLimit(clientIp(req));
    return this.authService.createEvmChallenge(body.walletAddress, origin);
  }

  @ApiDoc({
    summary: 'Get a Cardano login message',
    description:
      'Returns a single-use message (nonce + expiry) the wallet must CIP-30 signData with its stake key and send ' +
      'to /auth/login as signature',
    status: 200,
  })
  @HttpCode(HttpStatus.OK)
  @Post('cardano/challenge')
  async cardanoChallenge(@Body() body: CardanoChallengeReq, @Req() req: Request): Promise<{ message: string }> {
    await this.authService.assertChallengeRateLimit(clientIp(req));
    return this.authService.createCardanoChallenge(body.stakeAddress);
  }
}
