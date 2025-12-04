import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';

import { ContributionService } from './contribution.service';
import { ContributeReq } from './dto/contribute.req';
import { GetContributionTransactionsQueryDto } from './dto/get-contribution-transactions-query.dto';
import { GetContributionTransactionsRes } from './dto/get-contribution-transactions.res';

import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('Contributions')
@Controller('contribute')
export class ContributionController {
  constructor(
    private readonly contributionService: ContributionService,
    private readonly transactionsService: TransactionsService
  ) {}

  @Post(':vaultId')
  @ApiOperation({ summary: 'Contribute to a vault' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 201, description: 'Contribution successful' })
  async contribute(@Req() req: AuthRequest, @Param('vaultId') vaultId: string, @Body() contributeReq: ContributeReq) {
    const userId = req.user.sub;
    return this.contributionService.contribute(vaultId, contributeReq, userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get all contribution transactions' })
  @UseGuards(AuthGuard)
  @ApiResponse({
    status: 200,
    description: 'Returns all contribution transactions',
    type: GetContributionTransactionsRes,
  })
  async getContributionTransactions(
    @Query() query: GetContributionTransactionsQueryDto
  ): Promise<GetContributionTransactionsRes> {
    const transactions = await this.transactionsService.getContributionTransactions(query.vaultId);
    return { transactions };
  }
}
