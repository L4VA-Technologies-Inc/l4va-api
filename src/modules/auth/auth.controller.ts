import { Body, Controller, Get, Post, UseGuards, Version } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { AuthGuard } from '../../guards/auth.guard';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Version('1')
  @Post()
  @ApiOperation({ summary: 'Create a new vault' })
  @ApiResponse({ status: 201, description: 'Vault created successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  async signIn(@Body() signInDto: Record<string, any>) {
    return this.authService.signIn(signInDto.username, signInDto.password);
  }

  @UseGuards(AuthGuard)
  @Get('profile')
  async getProfile() {
    return true;
  }
}
