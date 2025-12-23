import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CreateProposalReq } from './dto/create-proposal.req';
import { CreateProposalRes } from './dto/create-proposal.res';
import { CreateSnapshotVaultParamDto, CreateSnapshotAssetParamDto } from './dto/create-snapshot-param.dto';
import { CreateSnapshotRes } from './dto/create-snapshot.res';
import { GetAssetsToDistributeRes } from './dto/get-assets-to-distribute.res';
import { GetAssetsToStakeRes } from './dto/get-assets-to-stake.res';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalDetailRes } from './dto/get-proposal-detail.res';
import { GetProposalsRes, GetProposalsResItem } from './dto/get-proposal.dto';
import { GetVotingPowerRes } from './dto/get-voting-power.res';
import { VoteReq } from './dto/vote.req';
import { VoteRes } from './dto/vote.res';
import { GovernanceService } from './governance.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';

@ApiTags('Governance')
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  @Post('vaults/:vaultId/proposals')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Create a new proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created successfully', type: CreateProposalRes })
  async createProposal(
    @Req() req,
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() data: CreateProposalReq
  ): Promise<CreateProposalRes> {
    return this.governanceService.createProposal(vaultId, data, req.user.sub);
  }

  @Post('snapshot/:vaultId/:assetId')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Create a snapshot for a vault' })
  @ApiResponse({ status: 201, description: 'Snapshot created successfully', type: CreateSnapshotRes })
  async createAutomaticSnapshot(
    @Param() params: CreateSnapshotVaultParamDto & CreateSnapshotAssetParamDto
  ): Promise<CreateSnapshotRes> {
    const snapshot = await this.governanceService.createAutomaticSnapshot(params.vaultId, params.assetId);
    return { snapshot };
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
  async getAssetsToBuySell(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return await this.governanceService.getAssetsToBuySell(vaultId);
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
  @ApiOperation({ summary: 'Get assets to distribute for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to distribute', type: GetAssetsToDistributeRes })
  async getAssetsToDistribute(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<GetAssetsToDistributeRes> {
    const assets = await this.governanceService.getAssetsToDistribute(vaultId);
    return { assets };
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
}
