import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DistributionService } from './distribution.service';
import { AssetMetadataRes } from './dto/asset-metadata.res';
import { CreateProposalReq } from './dto/create-proposal.req';
import { CreateProposalRes } from './dto/create-proposal.res';
import { GetDistributionInfoRes } from './dto/distribution.dto';
import { GetAssetsToListRes } from './dto/get-assets-to-list.res';
import { GetAssetsToStakeRes } from './dto/get-assets-to-stake.res';
import { GetOffersToCancelDto, PaginatedOffersToCancelResponseDto } from './dto/get-offers-to-cancel.dto';
import { GetProposalDetailRes } from './dto/get-proposal-detail.res';
import { GetProposalsDto, GetProposalsResItem } from './dto/get-proposal.dto';
import { GetVotingPowerRes } from './dto/get-voting-power.res';
import {
  BuildGovernanceFeeTransactionRes,
  GetGovernanceFeesRes,
  SubmitProposalFeePaymentReq,
} from './dto/governance-fee.dto';
import { VoteReq } from './dto/vote.req';
import { VoteRes } from './dto/vote.res';
import { EvmDistributionService } from './evm-distribution.service';
import { EvmGovernanceExecutionService } from './evm-governance-execution.service';
import { EvmGovernanceFeeService, type EvmGovernanceFeePayment } from './evm-governance-fee.service';
import { GovernanceFeeService } from './governance-fee.service';
import GovernanceService from './governance.service';

import { Vault } from '@/database/vault.entity';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';
import { PaginatedResponseDto } from '@/modules/vaults/dto/paginated-response.dto';
import {
  AssetBuySellDto,
  GetTerminationAssetsDto,
} from '@/modules/vaults/phase-management/governance/dto/get-assets.dto';
import { ChainType } from '@/types/vault.types';

@ApiTags('Governance')
@Controller('governance')
export class GovernanceController {
  constructor(
    private readonly governanceService: GovernanceService,
    private readonly distributionService: DistributionService,
    private readonly governanceFeeService: GovernanceFeeService,
    private readonly evmGovernanceFeeService: EvmGovernanceFeeService,
    private readonly evmDistributionService: EvmDistributionService,
    private readonly evmGovernanceExecutionService: EvmGovernanceExecutionService,
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>
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

  @Post('proposals/:proposalId/submit-fee-payment')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Submit governance fee payment for a proposal',
    description: 'Submits the signed fee transaction to blockchain and activates the proposal',
  })
  @ApiResponse({
    status: 200,
    description: 'Transaction submitted and proposal activated',
    schema: {
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        txHash: { type: 'string' },
      },
    },
  })
  async submitProposalFeePayment(
    @Req() req: AuthRequest,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() data: SubmitProposalFeePaymentReq
  ): Promise<{ success: boolean; message: string; txHash: string }> {
    return this.governanceService.submitProposalFeePayment(
      proposalId,
      { transaction: data.transaction, signatures: data.signatures, txHash: data.txHash },
      req.user.sub
    );
  }

  @Get('vaults/:vaultId/proposals')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Get all proposals for a vault' })
  @ApiResponse({ status: 200, description: 'Paginated list of proposals', type: PaginatedResponseDto })
  async getProposals(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Query() query: GetProposalsDto
  ): Promise<PaginatedResponseDto<GetProposalsResItem>> {
    return this.governanceService.getProposals(vaultId, query.page, query.limit);
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

  @Delete('proposals/:proposalId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Delete an upcoming or unpaid governance proposal (owner only)' })
  @ApiResponse({ status: 200, description: 'Proposal deleted successfully' })
  async deleteProposal(
    @Req() req: AuthRequest,
    @Param('proposalId', ParseUUIDPipe) proposalId: string
  ): Promise<{ success: boolean; message: string; refundTxHash?: string }> {
    return this.governanceService.deleteProposal(proposalId, req.user.sub);
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

  @Get('vaults/:vaultId/assets/sell')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets available for selling proposals' })
  @ApiResponse({
    status: 200,
    description: 'List of assets available for selling',
    type: GetAssetsToListRes,
  })
  async getAssetsToList(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<GetAssetsToListRes> {
    return await this.governanceService.getAssetsToList(vaultId);
  }

  @Get('vaults/:vaultId/offers-to-cancel')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get offers available for CANCEL_OFFER proposals',
    description:
      'Returns paginated active vault offers (OFFERED status) that can be cancelled via governance. Supports search by name, policy ID, or asset ID.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of offers to cancel',
    type: PaginatedOffersToCancelResponseDto,
  })
  async getOffersToCancel(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Query() query: GetOffersToCancelDto
  ): Promise<PaginatedResponseDto<AssetBuySellDto>> {
    return this.governanceService.getOffersToCancel(vaultId, query.page, query.limit, query.search);
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
  async getDistributionInfo(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Query('asset') asset?: string
  ): Promise<GetDistributionInfoRes | Awaited<ReturnType<EvmDistributionService['getDistributionInfo']>>> {
    // EVM vaults have no treasury wallet — the distributable funds sit in the
    // vault contract. Returning the Cardano shape here reported
    // `hasTreasuryWallet: false` and made the feature look broken in the UI.
    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'chain_type'],
    });
    if (vault?.chain_type === ChainType.robinhood) {
      return this.evmDistributionService.getDistributionInfo(vaultId, asset);
    }
    return this.distributionService.getDistributionInfo(vaultId);
  }

  @Get('vaults/:vaultId/distributions/:distributionId/claimable')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Get a holder's claimable amount for an EVM distribution",
    description:
      'Reads straight from the vault contract. Returns 0 once claimed, or if the holder was excluded at the snapshot timepoint.',
  })
  async getDistributionClaimable(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Param('distributionId') distributionId: string,
    @Query('holder') holder: string
  ): Promise<{ distributionId: string; holder: string; claimable: string }> {
    const claimable = await this.evmDistributionService.claimableFor(vaultId, distributionId, holder as `0x${string}`);
    return { distributionId, holder, claimable };
  }

  @Post('proposals/:proposalId/distribution/retry')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Retry opening a stalled EVM distribution',
    description:
      'Safe to call repeatedly: the on-chain execution key means a submission that already landed is adopted rather than duplicated.',
  })
  async retryDistribution(@Param('proposalId', ParseUUIDPipe) proposalId: string): Promise<{ success: boolean }> {
    const success = await this.evmGovernanceExecutionService.retryDistribution(proposalId);
    return { success };
  }

  @Get('vaults/:vaultId/assets/terminate')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get assets and LP validation info for termination',
    description: 'Returns assets to terminate along with LP pool validation and overall validation status',
  })
  @ApiResponse({
    status: 200,
    description: 'Termination assets and validation information',
    type: GetTerminationAssetsDto,
  })
  async getAssetsToTerminate(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<GetTerminationAssetsDto> {
    return this.governanceService.getAssetsToTerminate(vaultId);
  }

  @Get('vaults/:vaultId/assets/burn')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get assets to burn for a vault' })
  @ApiResponse({ status: 200, description: 'List of assets to burn' })
  async getAssetsToBurn(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<AssetBuySellDto[]> {
    return this.governanceService.getAssetsToBurn(vaultId);
  }

  @Get('assets/metadata/:unit')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get asset metadata by unit from Blockfrost',
    description:
      'Fetches on-chain asset metadata including display name. Unit must be at least 56 hex characters (policy ID + optional asset name).',
  })
  @ApiResponse({
    status: 200,
    description: 'Asset metadata fetched successfully',
    type: AssetMetadataRes,
  })
  @ApiResponse({ status: 400, description: 'Invalid unit format' })
  @ApiResponse({ status: 404, description: 'Asset not found on-chain' })
  async getAssetMetadata(@Param('unit') unit: string): Promise<AssetMetadataRes> {
    return this.governanceService.getAssetMetadataByUnit(unit);
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
      proposalFeeAssetWhitelistUpdate: this.governanceFeeService.getProposalFee('asset_whitelist_update'),
      votingFee: this.governanceFeeService.getVotingFee(),
      // EVM fees are wei decimal strings, denominated independently of the
      // lovelace values above. Clients pick a block based on the vault's chain.
      evm: {
        proposalFeeStaking: this.evmGovernanceFeeService.getProposalFeeWei('staking').toString(),
        proposalFeeDistribution: this.evmGovernanceFeeService.getProposalFeeWei('distribution').toString(),
        proposalFeeTermination: this.evmGovernanceFeeService.getProposalFeeWei('termination').toString(),
        proposalFeeBurning: this.evmGovernanceFeeService.getProposalFeeWei('burning').toString(),
        proposalFeeMarketplaceAction: this.evmGovernanceFeeService.getProposalFeeWei('marketplace_action').toString(),
        proposalFeeExpansion: this.evmGovernanceFeeService.getProposalFeeWei('expansion').toString(),
        proposalFeeAssetWhitelistUpdate: this.evmGovernanceFeeService
          .getProposalFeeWei('asset_whitelist_update')
          .toString(),
        votingFee: this.evmGovernanceFeeService.getVotingFeeWei().toString(),
      },
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

  @Post('proposals/:proposalId/vote-fee-payment')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get native voting fee payment parameters for an EVM (Robinhood) vault' })
  @ApiResponse({
    status: 201,
    description:
      'Transfer the wallet must broadcast to pay the voting fee. `payment` is null when no voting fee applies.',
  })
  async buildVoteFeePayment(): Promise<{ payment: EvmGovernanceFeePayment | null }> {
    // A quote, not a mutation — the wallet broadcasts the transfer itself and
    // passes the resulting hash to the vote endpoint as `feeTxHash`.
    return { payment: this.evmGovernanceFeeService.buildVotingFeePayment() };
  }
}
