import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards
} from '@nestjs/common';

import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import {ApiOperation, ApiResponse} from "@nestjs/swagger";
import {LoginReq} from "./dto/login.req";

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @ApiOperation({ summary: 'Login user' })
  @ApiResponse({
    status: 200,
    description: 'User login successful',
  })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() signatureData: LoginReq) {
    return this.authService.verifySignature(signatureData);
  }

  @UseGuards(AuthGuard)
  @Get('profile')
  getProfile(@Request() req) {
    return req.user;
  }
}
