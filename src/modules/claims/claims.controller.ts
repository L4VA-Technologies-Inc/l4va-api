import { Controller, Get, Post, Put, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { ClaimsService } from './claims.service';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimStatusDto } from './dto/update-claim-status.dto';

import { GetUser } from '@/common/decorators/get-user.decorator';

@ApiTags('Claims')
@Controller('claims')
@UseGuards(AuthGuard)
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Get('my')
  @ApiOperation({ summary: 'Get current user claims' })
  @ApiResponse({ type: [ClaimResponseDto] })
  async getMyClaims(@GetUser('id') userId: string) {
    return this.claimsService.getUserClaims(userId);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get user claims by user ID' })
  @ApiResponse({ type: [ClaimResponseDto] })
  async getUserClaims(@Param('userId') userId: string) {
    return this.claimsService.getUserClaims(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create new claim' })
  @ApiResponse({ type: ClaimResponseDto })
  async createClaim(@Body() createClaimDto: CreateClaimDto) {
    return this.claimsService.createClaim(createClaimDto);
  }

  @Put(':id/status')
  @ApiOperation({ summary: 'Update claim status' })
  @ApiResponse({ type: ClaimResponseDto })
  async updateClaimStatus(@Param('id') id: string, @Body() updateStatusDto: UpdateClaimStatusDto) {
    return this.claimsService.updateClaimStatus(id, updateStatusDto);
  }

  @Post(':id/claim')
  @ApiOperation({ summary: 'Process claim and build transaction' })
  async processClaim(@Param('id') id: string) {
    return this.claimsService.buildClaimTransaction(id);
  }
}
