import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { DistributionService } from './distribution.service';
import { CreateProposalReq } from './dto/create-proposal.req';
import { CreateProposalRes } from './dto/create-proposal.res';
import { GetDistributionInfoRes } from './dto/distribution.dto';
import { GetAssetsToStakeRes } from './dto/get-assets-to-stake.res';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalDetailRes } from './dto/get-proposal-detail.res';
import { GetProposalsRes, GetProposalsResItem } from './dto/get-proposal.dto';
import { GetVotingPowerRes } from './dto/get-voting-power.res';
import {
  BuildGovernanceFeeTransactionRes,
  BuildProposalFeeTransactionReq,
  GetGovernanceFeesRes,
} from './dto/governance-fee.dto';
import { VoteReq } from './dto/vote.req';
import { VoteRes } from './dto/vote.res';
import { GovernanceFeeService } from './governance-fee.service';
import { GovernanceService } from './governance.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';

@ApiTags('Governance')
@Controller('governance')
export class GovernanceController {
  constructor(
    private readonly governanceService: GovernanceService,
    private readonly distributionService: DistributionService,
    private readonly governanceFeeService: GovernanceFeeService
  ) {}

  @Post('vaults/:vaultId/proposals')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Create a new proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created successfully', type: CreateProposalRes })
  async createProposal(
    @Req() req: AuthRequest,
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() data: CreateProposalReq
  ): Promise<CreateProposalRes> {
    return this.governanceService.createProposal(vaultId, data, req.user.sub);
  }

  @Get('vaults/:vaultId/proposals')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Get all proposals for a vault' })
  @ApiResponse({ status: 200, description: 'List of proposals', type: [GetProposalsRes] })
  async getProposals(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<GetProposalsResItem[]> {
    return this.governanceService.getProposals(vaultId);
  }

  @Post('proposals/:proposalId/vote')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Vote on a proposal' })
  @ApiResponse({ status: 201, description: 'Vote recorded successfully', type: VoteRes })
  async vote(
    @Req() req: AuthRequest,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() voteReq: VoteReq
  ): Promise<VoteRes> {
    const userId = req.user.sub;
    return this.governanceService.vote(proposalId, voteReq, userId);
  }

  @Get('proposals/:proposalId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get proposal details' })
  @ApiResponse({ status: 200, description: 'Proposal details', type: GetProposalDetailRes })
  async getProposal(
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Req() req: AuthRequest
  ): Promise<GetProposalDetailRes> {
    return this.governanceService.getProposal(proposalId, req.user.sub);
  }

  @Get('vaults/:vaultId/voting-power')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get user voting power in a vault' })
  @ApiResponse({ status: 200, description: 'User voting power', type: GetVotingPowerRes })
  async getVotingPower(
    @Req() req: AuthRequest,
    @Param('vaultId', ParseUUIDPipe) vaultId: string
  ): Promise<GetVotingPowerRes> {
    const userId = req.user.sub;
    const votingPower = await this.governanceService.getVotingPower(vaultId, userId);
    return { votingPower };
  }

  @Get('vaults/:vaultId/assets/buy-sell')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets available for buying/selling proposals' })
  @ApiResponse({
    status: 200,
    description: 'List of assets available for trading',
    type: [AssetBuySellDto],
  })
  async getAssetsToList(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return await this.governanceService.getAssetsToList(vaultId);
  }

  @Get('vaults/:vaultId/assets/unlist')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets available for unlisting proposals' })
  @ApiResponse({
    status: 200,
    description: 'List of assets available for unlisting',
    type: [AssetBuySellDto],
  })
  async getAssetsToUnlist(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return await this.governanceService.getAssetsToUnlist(vaultId);
  }

  @Get('vaults/:vaultId/assets/update-listing')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets available for updating listings' })
  @ApiResponse({
    status: 200,
    description: 'List of assets available for updating listings',
    type: [AssetBuySellDto],
  })
  async getAssetsToUpdateListing(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return await this.governanceService.getAssetsToUpdateListing(vaultId);
  }

  @Get('vaults/:vaultId/assets/stake')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to stake for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to stake', type: GetAssetsToStakeRes })
  async getAssetsToStake(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<GetAssetsToStakeRes> {
    const assets = await this.governanceService.getAssetsToStake(vaultId);
    return { assets };
  }

  @Get('vaults/:vaultId/assets/distribute')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get distribution info for a vault',
    description: 'Returns treasury balance, VT holder count, and distribution limits for UI',
  })
  @ApiResponse({ status: 200, description: 'Distribution info', type: GetDistributionInfoRes })
  async getDistributionInfo(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<GetDistributionInfoRes> {
    return this.distributionService.getDistributionInfo(vaultId);
  }

  @Get('vaults/:vaultId/assets/terminate')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to terminate for a vault' })
  @ApiResponse({
    status: 200,
    description: 'List of assets to terminate',
    type: [AssetBuySellDto],
  })
  async getAssetsToTerminate(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return this.governanceService.getAssetsToTerminate(vaultId);
  }

  @Get('vaults/:vaultId/assets/burn')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to burn for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to burn' })
  async getAssetsToBurn(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return this.governanceService.getAssetsToBurn(vaultId);
  }

  @Get('vaults/:vaultId/swappable-assets')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get fungible tokens available for swapping via DexHunter' })
  @ApiResponse({ status: 200, description: 'List of swappable FT assets with current prices' })
  async getSwappableAssets(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<any[]> {
    return this.governanceService.getSwappableAssets(vaultId);
  }

  @Get('governance-fees')
  @ApiOperation({ summary: 'Get all governance fees' })
  @ApiResponse({ status: 200, description: 'Governance fees for proposals and voting', type: GetGovernanceFeesRes })
  async getGovernanceFees(): Promise<GetGovernanceFeesRes> {
    return {
      proposalFeeStaking: this.governanceFeeService.getProposalFee('staking'),
      proposalFeeDistribution: this.governanceFeeService.getProposalFee('distribution'),
      proposalFeeTermination: this.governanceFeeService.getProposalFee('termination'),
      proposalFeeBurning: this.governanceFeeService.getProposalFee('burning'),
      proposalFeeMarketplaceAction: this.governanceFeeService.getProposalFee('marketplace_action'),
      proposalFeeExpansion: this.governanceFeeService.getProposalFee('expansion'),
      votingFee: this.governanceFeeService.getVotingFee(),
    };
  }

  @Post('vaults/:vaultId/proposals/fee-transaction')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Build governance fee transaction for proposal creation' })
  @ApiResponse({
    status: 201,
    description: 'Presigned transaction for fee payment',
    type: BuildGovernanceFeeTransactionRes,
  })
  async buildProposalFeeTransaction(
    @Req() req: AuthRequest,
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() data: BuildProposalFeeTransactionReq
  ): Promise<BuildGovernanceFeeTransactionRes> {
    const result = await this.governanceFeeService.buildProposalFeeTransaction({
      userAddress: data.userAddress,
      proposalType: data.proposalType,
      vaultId,
    });

    return {
      presignedTx: result.presignedTx,
      feeAmount: result.feeAmount,
    };
  }

  @Post('proposals/:proposalId/vote-fee-transaction')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Build governance fee transaction for voting' })
  @ApiResponse({
    status: 201,
    description: 'Presigned transaction for voting fee payment',
    type: BuildGovernanceFeeTransactionRes,
  })
  async buildVoteFeeTransaction(
    @Req() req: AuthRequest,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() data: { userAddress: string }
  ): Promise<BuildGovernanceFeeTransactionRes> {
    const result = await this.governanceFeeService.buildVotingFeeTransaction({
      userAddress: data.userAddress,
      proposalId,
    });

    return {
      presignedTx: result.presignedTx,
      feeAmount: result.feeAmount,
    };
  }
}
