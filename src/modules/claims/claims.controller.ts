import { Controller, Get, Post, Put, Param, Body, UseGuards, Query, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { AuthGuard } from '../auth/auth.guard';

import { ClaimsService } from './claims.service';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { CreateClaimDto } from './dto/create-claim.dto';
import { GetClaimsDto } from './dto/get-claims.dto';
import { UpdateClaimStatusDto } from './dto/update-claim-status.dto';

import { ApiDoc } from '@/decorators/api-doc.decorator';

@ApiTags('Claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @ApiDoc({
    summary: 'Get current user claims',
    description: 'Returns claims for current user with optional filtering by status or claim state',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  @ApiResponse({ type: [ClaimResponseDto] })
  async getMyClaims(@Request() req, @Query() query: GetClaimsDto) {
    const userId = req.user.sub;
    return this.claimsService.getUserClaims(userId, query);
  }

  @UseGuards(AuthGuard)
  @Get('user/:userId')
  @ApiOperation({ summary: 'Get user claims by user ID' })
  @ApiResponse({ type: [ClaimResponseDto] })
  async getUserClaims(@Param('userId') userId: string) {
    return this.claimsService.getUserClaims(userId);
  }

  @UseGuards(AuthGuard)
  @Post()
  @ApiOperation({ summary: 'Create new claim' })
  @ApiResponse({ type: ClaimResponseDto })
  async createClaim(@Body() createClaimDto: CreateClaimDto) {
    return this.claimsService.createClaim(createClaimDto);
  }

  @UseGuards(AuthGuard)
  @Put(':id/status')
  @ApiOperation({ summary: 'Update claim status' })
  @ApiResponse({ type: ClaimResponseDto })
  async updateClaimStatus(@Param('id') id: string, @Body() updateStatusDto: UpdateClaimStatusDto) {
    return this.claimsService.updateClaimStatus(id, updateStatusDto);
  }

  @UseGuards(AuthGuard)
  @Post(':id/claim')
  @ApiOperation({ summary: 'Process claim and build transaction' })
  async processClaim(@Param('id') id: string) {
    return this.claimsService.buildClaimTransaction(id);
  }
}
