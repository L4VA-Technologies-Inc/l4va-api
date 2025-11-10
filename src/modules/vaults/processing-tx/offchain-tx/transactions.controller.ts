import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';
import { TransactionsService } from "@/modules/vaults/processing-tx/offchain-tx/transactions.service";
import { AuthRequest } from "@/modules/auth/dto/auth-user.interface";
import { GetTransactionsDto } from "@/modules/vaults/processing-tx/offchain-tx/dto/get-transactions.dto";

@ApiTags('Transactions')
@Controller('transactions')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {
  }

  @Get('')
  @ApiOperation({ summary: 'Get user transactions' })
  async getByUserId(@Request() req: AuthRequest, @Query() query: GetTransactionsDto) {
    const userId = req.user.sub;
    return this.transactionsService.getByUserId(userId, query);
  }

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
  async getTransaction(@Param('txHash') _txHash: string) {
    //return this.transactionsService.getTransaction(txHash);
    return null;
  }
}
