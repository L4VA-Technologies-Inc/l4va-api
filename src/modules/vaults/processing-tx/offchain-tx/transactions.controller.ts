import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';

import { TransactionsResponseDto } from './dto/transactions-response.dto';

import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { GetTransactionsDto } from '@/modules/vaults/processing-tx/offchain-tx/dto/get-transactions.dto';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';

@ApiTags('Transactions')
@Controller('transactions')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'Get user transactions' })
  async getByUserId(@Request() req: AuthRequest, @Query() query: GetTransactionsDto): Promise<TransactionsResponseDto> {
    const userId = req.user.sub;
    return this.transactionsService.getByUserId(userId, query);
  }
}
