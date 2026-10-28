import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { EvmChallengeReq, LoginReq } from './dto/login.req';
import { LoginRes } from './dto/login.res';

import { ApiDoc } from '@/decorators/api-doc.decorator';

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
  async evmChallenge(@Body() body: EvmChallengeReq, @Headers('origin') origin?: string): Promise<{ message: string }> {
    return this.authService.createEvmChallenge(body.walletAddress, origin);
  }
}
