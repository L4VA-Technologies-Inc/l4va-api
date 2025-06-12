import { Controller, Post, Body, UseGuards, BadRequestException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { AuthGuard } from '../../auth/auth.guard';

import { ExtractLpTokensDto } from './dto/extract-lp-tokens.dto';
import { LpTokensService } from './services/lp-tokens.service';

@ApiTags('LP Tokens')
@Controller('lp-tokens')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class LpTokensController {
  constructor(private readonly lpTokensService: LpTokensService) {}

  @Post('extract')
  @ApiOperation({
    summary: 'Extract LP tokens from a vault',
    description: 'Extracts LP tokens from a specified vault to a wallet address.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'LP tokens extraction initiated successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input parameters',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized',
  })
  async extractLpTokens(@Body() extractDto: ExtractLpTokensDto) {
    try {
      const result = await this.lpTokensService.extractLpTokens(extractDto);
      return {
        success: true,
        transactionId: result.transactionId,
        message: 'LP tokens extraction initiated successfully',
      };
    } catch (error) {
      throw new BadRequestException({
        success: false,
        message: error.message || 'Failed to extract LP tokens',
      });
    }
  }
}
