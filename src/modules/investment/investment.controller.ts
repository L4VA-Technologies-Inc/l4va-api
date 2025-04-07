import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InvestmentService } from './investment.service';
import { InvestReq } from './dto/invest.req';
import { AuthGuard } from '../auth/auth.guard';
import { TxUpdateReq } from '../contribution/dto/txUpdate.req';
import { TransactionsService } from '../transactions/transactions.service';

@ApiTags('Investments')
@Controller('investments')
export class InvestmentController {
  constructor(
    private readonly investmentService: InvestmentService,
    private readonly transactionsService: TransactionsService
  ) {}

  @Post(':vaultId')
  @ApiOperation({ summary: 'Invest in a vault' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 201, description: 'Investment successful' })
  async invest(
    @Req() req,
    @Param('vaultId') vaultId: string,
    @Body() investReq: InvestReq,
  ) {
    const userId = req.user.sub;
    return this.investmentService.invest(vaultId, investReq, userId);
  }

  @Patch('transaction/:txId/hash')
  @ApiOperation({ summary: 'Update transaction hash' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Transaction hash updated successfully' })
  async updateTransactionHash(
    @Param('txId') txId: string,
    @Body() txUpdate: TxUpdateReq
  ) {
    return this.investmentService.updateTransactionHash(txId, txUpdate.txHash);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get all investment transactions' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Returns all investment transactions' })
  async getInvestmentTransactions(
    @Query('vaultId') vaultId?: string
  ) {
    return this.transactionsService.getInvestmentTransactions(vaultId);
  }
}
