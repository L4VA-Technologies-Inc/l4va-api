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
import {ApiOperation, ApiResponse, ApiTags} from "@nestjs/swagger";
import {LoginReq} from "./dto/login.req";
import {ApiDoc} from "../../decorators/api-doc.decorator";

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
