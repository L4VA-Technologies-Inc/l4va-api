import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { BuildTxRes } from './dto/build-tx.res';
import { StakeTokensDto } from './dto/stake-tokens.dto';
import { StakedBalanceRes } from './dto/staked-balance.res';
import { SubmitStakeTxDto } from './dto/submit-stake-tx.dto';
import { SubmitTxRes } from './dto/submit-tx.res';
import { UnstakeTokensDto } from './dto/unstake-tokens.dto';
import { StakeService } from './stake.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('stake')
@Controller('stake')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class StakeController {
  constructor(private readonly stakeService: StakeService) {}

  /** Ensures the payment address in the request body matches the JWT wallet. */
  private ensureWalletMatchesUser(req: AuthRequest, userAddress: string): void {
    if (req.user.address !== userAddress) {
      throw new ForbiddenException('User address does not match the authenticated wallet');
    }
  }

  @Get('balance')
  @ApiOperation({
    summary: 'Live staked boxes from the smart contract (Blockfrost)',
    description:
      'Returns individual UTxO boxes locked at the staking contract for the current user. ' +
      'Each box includes the staked amount, estimated reward/payout, eligibility status, and cooldown end time. ' +
      'Use this to display per-box info and let the user select which boxes to unstake.',
  })
  @ApiResponse({ status: 200, type: StakedBalanceRes })
  async getMyStakedBalance(@Req() req: AuthRequest): Promise<StakedBalanceRes> {
    return this.stakeService.getOnChainStakedBalance(req.user.sub, req.user.address);
  }

  @Post('build-stake')
  @ApiOperation({ summary: 'Build unsigned stake transaction (CBOR)' })
  @ApiResponse({ status: 201, description: 'txCbor + transactionId on success', type: BuildTxRes })
  async buildStake(@Req() req: AuthRequest, @Body() body: StakeTokensDto): Promise<BuildTxRes> {
    this.ensureWalletMatchesUser(req, body.userAddress);
    return this.stakeService.buildStakeTx(req.user.sub, body.userAddress, body.assetId, body.amount);
  }

  @Post('build-unstake')
  @ApiOperation({
    summary: 'Build unsigned unstake transaction (CBOR)',
    description:
      'Pass the list of UTxO refs (txHash + outputIndex) the user selected. ' +
      'Only eligible boxes (verified + cooldown passed) will be included in the transaction.',
  })
  @ApiResponse({ status: 201, description: 'Unsigned transaction or error', type: BuildTxRes })
  async buildUnstake(@Req() req: AuthRequest, @Body() body: UnstakeTokensDto): Promise<BuildTxRes> {
    this.ensureWalletMatchesUser(req, body.userAddress);
    return this.stakeService.buildUnstakeTx(req.user.sub, body.userAddress, body.utxos);
  }

  @Post('submit')
  @ApiOperation({ summary: 'Assemble witnesses and submit signed transaction' })
  @ApiResponse({ status: 201, description: 'Submission result', type: SubmitTxRes })
  async submit(@Req() req: AuthRequest, @Body() body: SubmitStakeTxDto): Promise<SubmitTxRes> {
    return this.stakeService.submitTransaction(req.user.sub, body);
  }
}
