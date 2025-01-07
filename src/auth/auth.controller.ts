import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  async login(@Body() signatureData: {
    signature: any;
    stakeAddress: string;
  }) {
    return this.authService.verifySignature(signatureData);
  }
}
