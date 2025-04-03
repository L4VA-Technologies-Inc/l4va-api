import {Body, Controller, Param, Patch, Post, Req, UseGuards} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ContributionService } from './contribution.service';
import { ContributeReq } from './dto/contribute.req';
import {AuthGuard} from '../auth/auth.guard';
import {TxUpdateReq} from "./dto/txUpdate.req";

@ApiTags('Contributions')
@Controller('contribute')
export class ContributionController {
  constructor(private readonly contributionService: ContributionService) {}

  @Post(':vaultId')
  @ApiOperation({ summary: 'Contribute to a vault' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 201, description: 'Contribution successful' })
  async contribute(
    @Req() req,
    @Param('vaultId') vaultId: string,
    @Body() contributeReq: ContributeReq
  ) {
    const userId = req.user.sub;
    return this.contributionService.contribute(vaultId, contributeReq, userId);
  }

  @Patch('transaction/:txId/hash')
  @ApiOperation({ summary: 'Update transaction hash' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 200, description: 'Transaction hash updated successfully' })
  async updateTransactionHash(
    @Param('txId') txId: string,
    @Body() txUpdate: TxUpdateReq
  ) {
    return this.contributionService.updateTransactionHash(txId, txUpdate.txHash);
  }
}
