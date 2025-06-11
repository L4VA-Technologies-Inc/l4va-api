import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { AuthService } from './auth.service';
import { LoginReq } from './dto/login.req';

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
  async login(@Body() signatureData: LoginReq) {
    return this.authService.verifySignature(signatureData);
  }
}
