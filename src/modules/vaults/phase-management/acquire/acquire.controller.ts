import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { ContributionAsset } from '../contribution/dto/contribute.req';

import { AcquireService } from './acquire.service';
import { AcquireReq } from './dto/acquire.req';

import { Transaction } from '@/database/transaction.entity';

@ApiTags('Acquire')
@Controller('acquire')
export class AcquireController {
  constructor(
    private readonly acquireService: AcquireService,
    private readonly transactionsService: TransactionsService
  ) {}

  @Post(':vaultId')
  @ApiOperation({ summary: 'Acquire in a vault' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 201, description: 'Acquire successful' })
  async invest(
    @Req() req,
    @Param('vaultId') vaultId: string,
    @Body() acquireReq: AcquireReq
  ): Promise<{
    success: boolean;
    message: string;
    vaultId: string;
    txId: string;
    assets: ContributionAsset[];
  }> {
    const userId = req.user.sub;
    return this.acquireService.acquire(vaultId, acquireReq, userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get all acquire transactions' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Returns all acquire transactions' })
  async getInvestmentTransactions(@Query('vaultId') vaultId?: string): Promise<Transaction[]> {
    return this.transactionsService.getAcquireTransactions(vaultId);
  }
}
