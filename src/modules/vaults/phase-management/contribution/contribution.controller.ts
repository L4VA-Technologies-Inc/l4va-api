import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';

import { ContributionService } from './contribution.service';
import { ContributeReq } from './dto/contribute.req';

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
  async contribute(@Req() req, @Param('vaultId') vaultId: string, @Body() contributeReq: ContributeReq) {
    const userId = req.user.sub;
    return this.contributionService.contribute(vaultId, contributeReq, userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get all contribution transactions' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Returns all contribution transactions' })
  async getContributionTransactions(@Query('vaultId') vaultId?: string) {
    return this.transactionsService.getContributionTransactions(vaultId);
  }
}
