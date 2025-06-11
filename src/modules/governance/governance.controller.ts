import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../auth/auth.guard';

import { CreateProposalReq } from './dto/create-proposal.req';
import { VoteReq } from './dto/vote.req';
import { GovernanceService } from './governance.service';

@ApiTags('Governance')
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  @Post('vaults/:vaultId/proposals')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Create a new proposal' })
  @ApiResponse({ status: 201, description: 'Proposal created successfully' })
  async createProposal(@Req() req, @Param('vaultId') vaultId: string, @Body() createProposalReq: CreateProposalReq) {
    const userId = req.user.sub;
    return this.governanceService.createProposal(vaultId, createProposalReq, userId);
  }

  @Get('vaults/:vaultId/proposals')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get all proposals for a vault' })
  @ApiResponse({ status: 200, description: 'List of proposals' })
  async getProposals(@Param('vaultId') vaultId: string) {
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
  async getProposal(@Param('proposalId') proposalId: string) {
    return this.governanceService.getProposal(proposalId);
  }
}
