import { Body, Controller, Post, Version } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthService } from './auth.service';

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
}
