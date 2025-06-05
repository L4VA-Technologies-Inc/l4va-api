import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AcquireService } from './acquire.service';
import { AcquireReq } from './dto/acquire.req';
import { AuthGuard } from '../../../auth/auth.guard';
import { TxUpdateReq } from '../contribution/dto/txUpdate.req';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';

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
    @Body() acquireReq: AcquireReq,
  ) {
    const userId = req.user.sub;
    return this.acquireService.acquire(vaultId, acquireReq, userId);
  }

  @Patch('transaction/:txId/hash')
  @ApiOperation({ summary: 'Update transaction hash' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Transaction hash updated successfully' })
  async updateTransactionHash(
    @Param('txId') txId: string,
    @Body() txUpdate: TxUpdateReq
  ) {
    return this.acquireService.updateTransactionHash(txId, txUpdate.txHash);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get all acquire transactions' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Returns all acquire transactions' })
  async getInvestmentTransactions(
    @Query('vaultId') vaultId?: string
  ) {
    return this.transactionsService.getAcquireTransactions(vaultId);
  }
}
