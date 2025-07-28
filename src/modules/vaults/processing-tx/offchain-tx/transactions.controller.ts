import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';

import { WaitingTransactionsResponseDto } from './dto/waiting-transactions-response.dto';
import { TransactionsService } from './transactions.service';

@ApiTags('Transactions')
@Controller('transactions')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get('sent')
  @ApiOperation({ summary: 'Get transactions sent by the authenticated user' })
  async getSentTransactions() {
    // return this.transactionsService.getTransactionsBySender(address);
    return null;
  }

  @Get('received')
  @ApiOperation({ summary: 'Get transactions received by the authenticated user' })
  async getReceivedTransactions() {
    // return this.transactionsService.getTransactionsByReceiver(address);
    return null;
  }

  @Get('waiting-owner')
  @ApiOperation({ summary: 'Get transactions waiting for owner' })
  @ApiResponse({
    status: 200,
    description: 'List of transactions waiting for owner signature',
    type: [WaitingTransactionsResponseDto],
  })
  async getWaitingOwnerTransactions(@Request() req) {
    return this.transactionsService.getWaitingOwnerTransactions(req.user.sub);
  }

  @Get(':txHash')
  @ApiOperation({ summary: 'Get transaction details by transaction hash' })
  async getTransaction(@Param('txHash') _txHash: string) {
    //return this.transactionsService.getTransaction(txHash);
    return null;
  }
}
