import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { BuildTxRes } from './dto/build-tx.res';
import { CompoundTokensDto } from './dto/compound-tokens.dto';
import { HarvestTokensDto } from './dto/harvest-tokens.dto';
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
    summary: 'Active staking positions (from database)',
    description:
      'Returns individual staking positions tracked in the database for the current user. ' +
      'Each entry corresponds to one on-chain box and includes the staked amount, ' +
      'estimated reward/payout, and the UTxO ref needed to unstake/harvest/compound.',
  })
  @ApiResponse({ status: 200, type: StakedBalanceRes })
  async getMyStakedBalance(@Req() req: AuthRequest): Promise<StakedBalanceRes> {
    return this.stakeService.getStakedBalanceFromDb(req.user.sub);
  }

  @Post('build-stake')
  @ApiOperation({ summary: 'Build unsigned stake transaction (CBOR)' })
  @ApiResponse({ status: 201, description: 'txCbor + transactionId on success', type: BuildTxRes })
  async buildStake(@Req() req: AuthRequest, @Body() body: StakeTokensDto): Promise<BuildTxRes> {
    this.ensureWalletMatchesUser(req, body.userAddress);
    return this.stakeService.buildStakeTx(req.user.sub, body.userAddress, body.tokens);
  }

  @Post('build-unstake')
  @ApiOperation({
    summary: 'Build unsigned unstake transaction (CBOR)',
    description:
      'Pass the list of UTxO refs (txHash + outputIndex) the user selected. ' +
      'Only eligible boxes (verified) will be included. ' +
      'Full payout (deposit + reward) is sent to the user.',
  })
  @ApiResponse({ status: 201, description: 'Unsigned transaction or error', type: BuildTxRes })
  async buildUnstake(@Req() req: AuthRequest, @Body() body: UnstakeTokensDto): Promise<BuildTxRes> {
    this.ensureWalletMatchesUser(req, body.userAddress);
    return this.stakeService.buildUnstakeTx(req.user.sub, body.userAddress, body.utxos);
  }

  @Post('build-harvest')
  @ApiOperation({
    summary: 'Build unsigned harvest transaction (CBOR)',
    description:
      'Collect accrued rewards from selected boxes and send them to the user wallet. ' +
      'The original deposit stays locked in the contract with a fresh staked_at timer. ' +
      'Requires the boxes to pass the eligibility check (trusted staked_at). ' +
      'Rewards are sent to the user wallet.',
  })
  @ApiResponse({ status: 201, description: 'Unsigned transaction or error', type: BuildTxRes })
  async buildHarvest(@Req() req: AuthRequest, @Body() body: HarvestTokensDto): Promise<BuildTxRes> {
    this.ensureWalletMatchesUser(req, body.userAddress);
    return this.stakeService.buildHarvestTx(req.user.sub, body.userAddress, body.utxos);
  }

  @Post('build-compound')
  @ApiOperation({
    summary: 'Build unsigned compound (restake) transaction (CBOR)',
    description:
      'Reinvest accrued rewards into the staking contract — deposit + reward are locked as one new box ' +
      'with a fresh staked_at timer. Nothing is sent to the user wallet. ' +
      'Requires the boxes to pass the eligibility check (trusted staked_at).',
  })
  @ApiResponse({ status: 201, description: 'Unsigned transaction or error', type: BuildTxRes })
  async buildCompound(@Req() req: AuthRequest, @Body() body: CompoundTokensDto): Promise<BuildTxRes> {
    this.ensureWalletMatchesUser(req, body.userAddress);
    return this.stakeService.buildCompoundTx(req.user.sub, body.userAddress, body.utxos);
  }

  @Post('submit')
  @ApiOperation({
    summary: 'Assemble witnesses and submit signed transaction',
    description:
      'Works for stake, unstake, harvest and compound transaction types. ' +
      'Admin co-signs unstake/harvest/compound automatically.',
  })
  @ApiResponse({ status: 201, description: 'Submission result', type: SubmitTxRes })
  async submit(@Req() req: AuthRequest, @Body() body: SubmitStakeTxDto): Promise<SubmitTxRes> {
    return this.stakeService.submitTransaction(req.user.sub, body);
  }
}
