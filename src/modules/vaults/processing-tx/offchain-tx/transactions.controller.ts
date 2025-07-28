import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';

import { TransactionsService } from './transactions.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';

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

  @ApiDoc({
    summary: 'Get transactions waiting for owner',
    description: 'Fetch all transactions that are waiting for the owner to sign them.',
    status: 200,
  })
  @Get('waiting-owner')
  @ApiOperation({ summary: 'Get transactions waiting for owner' })
  async getWaitingOwnerTransactions(@Request() req: any) {
    return this.transactionsService.getWaitingOwnerTransactions(req.user.id);
  }

  @Get(':txHash')
  @ApiOperation({ summary: 'Get transaction details by transaction hash' })
  async getTransaction(@Param('txHash') _txHash: string) {
    //return this.transactionsService.getTransaction(txHash);
    return null;
  }
}
