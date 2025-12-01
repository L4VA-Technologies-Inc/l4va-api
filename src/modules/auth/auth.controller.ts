import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { LoginReq } from './dto/login.req';
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
  async login(@Body() signatureData: LoginReq): Promise<LoginRes> {
    return this.authService.verifySignature(signatureData);
  }
}
