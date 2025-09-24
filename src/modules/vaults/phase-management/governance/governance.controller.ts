import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../../../auth/auth.guard';

import { CreateProposalReq } from './dto/create-proposal.req';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalsRes, GetProposalsResItem } from './dto/get-proposal.dto';
import { VoteReq } from './dto/vote.req';
import { GovernanceService } from './governance.service';

import { Asset } from '@/database/asset.entity';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';

@ApiTags('Governance')
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  @Post('vaults/:vaultId/proposals')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Create a new proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created successfully' })
  async createProposal(@Req() req, @Param('vaultId') vaultId: string, @Body() data: CreateProposalReq) {
    return this.governanceService.createProposal(vaultId, data, req.user.sub);
  }

  @Get('vaults/:vaultId/proposals')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Get all proposals for a vault' })
  @ApiResponse({ status: 200, description: 'List of proposals', type: [GetProposalsRes] })
  async getProposals(@Param('vaultId') vaultId: string): Promise<GetProposalsResItem[]> {
    return this.governanceService.getProposals(vaultId);
  }

  @Post('proposals/:proposalId/vote')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Vote on a proposal' })
  @ApiResponse({ status: 201, description: 'Vote recorded successfully' })
  async vote(@Req() req, @Param('proposalId') proposalId: string, @Body() voteReq: VoteReq) {
    const userId = req.user.sub;
    return this.governanceService.vote(proposalId, voteReq, userId);
  }

  @Get('proposals/:proposalId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get proposal details' })
  @ApiResponse({ status: 200, description: 'Proposal details' })
  async getProposal(@Param('proposalId') proposalId: string, @Req() req) {
    return this.governanceService.getProposal(proposalId, req.user.sub);
  }

  @Get('vaults/:vaultId/voting-power')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get user voting power in a vault' })
  @ApiResponse({ status: 200, description: 'User voting power' })
  async getVotingPower(@Req() req, @Param('vaultId') vaultId: string): Promise<string> {
    const userId = req.user.sub;
    return this.governanceService.getVotingPower(vaultId, userId);
  }

  @Get('vaults/:vaultId/assets/buy-sell')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets available for buying/selling proposals' })
  @ApiResponse({
    status: 200,
    description: 'List of assets available for trading',
    type: [AssetBuySellDto],
  })
  async getAssetsToBuySell(@Param('vaultId') vaultId: string): Promise<AssetBuySellDto[]> {
    return await this.governanceService.getAssetsToBuySell(vaultId);
  }

  @Get('vaults/:vaultId/assets/stake')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to stake for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to stake' })
  async getAssetsToStake(@Param('vaultId') vaultId: string): Promise<Asset[]> {
    return this.governanceService.getAssetsToStake(vaultId);
  }

  @Get('vaults/:vaultId/assets/distribute')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to distribute for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to distribute' })
  async getAssetsToDistribute(@Param('vaultId') vaultId: string): Promise<Asset[]> {
    return this.governanceService.getAssetsToDistribute(vaultId);
  }

  @Get('vaults/:vaultId/assets/terminate')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to terminate for a vault' })
  @ApiResponse({
    status: 200,
    description: 'List of assets to terminate',
    type: [AssetBuySellDto],
  })
  async getAssetsToTerminate(@Param('vaultId') vaultId: string): Promise<AssetBuySellDto[]> {
    return this.governanceService.getAssetsToTerminate(vaultId);
  }

  @Get('vaults/:vaultId/assets/burn')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to burn for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to burn' })
  async getAssetsToBurn(@Param('vaultId') vaultId: string): Promise<AssetBuySellDto[]> {
    return this.governanceService.getAssetsToBurn(vaultId);
  }
}
