import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { FaucetClaimRes, FaucetStatusRes } from './dto/faucet.res';
import { FaucetService } from './faucet.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('faucet')
@Controller('faucet')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class FaucetController {
  constructor(private readonly faucetService: FaucetService) {}

  @Get('status')
  @ApiOperation({ summary: 'Testnet faucet availability, tokens and the caller cooldown' })
  @ApiResponse({ status: 200, type: FaucetStatusRes })
  getStatus(@Req() req: AuthRequest): Promise<FaucetStatusRes> {
    return this.faucetService.getStatus(req.user.address);
  }

  @Post('claim')
  @ApiOperation({ summary: 'Mint test tokens to the caller wallet (testnet only, once per cooldown)' })
  @ApiResponse({ status: 201, type: FaucetClaimRes })
  claim(@Req() req: AuthRequest): Promise<FaucetClaimRes> {
    return this.faucetService.claim(req.user.address);
  }
}
