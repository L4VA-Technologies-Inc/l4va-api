import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import {AuthGuard} from '../auth/auth.guard';

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

  @Get(':txHash')
  @ApiOperation({ summary: 'Get transaction details by transaction hash' })
  async getTransaction(@Param('txHash') txHash: string) {
    //return this.transactionsService.getTransaction(txHash);
    return null;
  }
}
