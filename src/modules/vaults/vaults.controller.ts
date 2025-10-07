import { Controller, Post, Body, Get, Param, Request, UseGuards, Query, Logger, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { AuthRequest } from '../auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';

import { DraftVaultsService } from './draft-vaults.service';
import { CreateVaultReq } from './dto/createVault.req';
import { GetVaultTransactionsDto } from './dto/get-vault-transactions.dto';
import { VaultStatisticsResponse } from './dto/get-vaults-statistics.dto';
import { GetVaultsDto } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { PublishVaultDto } from './dto/publish-vault.dto';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultAcquireResponse, VaultFullResponse, VaultShortResponse } from './dto/vault.response';
import { TransactionsService } from './processing-tx/offchain-tx/transactions.service';
import { VaultsService } from './vaults.service';

import { Transaction } from '@/database/transaction.entity';

@ApiTags('vaults')
@Controller('vaults')
export class VaultsController {
  private readonly logger = new Logger(VaultsController.name);
  constructor(
    private readonly vaultsService: VaultsService,
    private readonly draftVaultsService: DraftVaultsService,
    private readonly transactionsService: TransactionsService
  ) {}

  @ApiDoc({
    summary: 'Create vault',
    description: 'Vault successfully created',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post()
  createVault(
    @Request() req: AuthRequest,
    @Body()
    data: CreateVaultReq
  ): Promise<{
    vaultId: string;
    presignedTx: string;
  }> {
    const userId = req.user.sub;
    return this.vaultsService.createVault(userId, data);
  }

  @ApiDoc({
    summary: 'Publish vault',
    description: 'Publishes a vault with the provided transaction',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('/publish')
  async publishVault(@Request() req, @Body() publishDto: PublishVaultDto): Promise<VaultFullResponse> {
    const userId = req.user.sub;
    try {
      return await this.vaultsService.publishVault(userId, publishDto);
    } catch (error) {
      this.logger.error('Error publishing vault', error);
      throw error;
    }
  }

  @ApiDoc({
    summary: 'Save draft vault',
    description: 'Vault successfully saved',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('save-draft')
  saveDraft(
    @Request() req: AuthRequest,
    @Body()
    data: SaveDraftReq
  ): Promise<any> {
    const userId = req.user.sub;
    return this.draftVaultsService.saveDraftVault(userId, data);
  }

  @ApiDoc({
    summary: 'List of vaults - works with or without authentication',
    description:
      'Returns paginated list of vaults. For authenticated users, includes private vaults they have access to. For unauthenticated users, shows only public vaults. Default page: 1, default limit: 10. Supports sorting by name, created_at, or updated_at.',
    status: 200,
  })
  @Post('search')
  @UseGuards(OptionalAuthGuard)
  getVaults(@Body() filters: GetVaultsDto, @Request() req: any): Promise<PaginatedResponseDto<VaultShortResponse>> {
    const userId = req.user?.sub;

    if (filters.ownerId) {
      return this.vaultsService.getVaults({
        ...filters,
        isPublicOnly: true,
      });
    }

    // If no user is authenticated, only show public vaults
    if (!userId) {
      return this.vaultsService.getVaults({
        ...filters,
      });
    }

    // For authenticated users, show all vaults they have access to
    return this.vaultsService.getVaults({
      userId,
      ...filters,
    });
  }

  @ApiOperation({ summary: 'Increment view count for a vault by vault id' })
  @ApiParam({ name: 'id', description: 'Vault ID' })
  @Post(':id/view')
  async incrementViewCount(@Param('id', new ParseUUIDPipe()) vaultId: string) {
    return this.vaultsService.incrementViewCount(vaultId);
  }

  @ApiDoc({
    summary: 'List of biggest investments',
    description: 'Returns list of biggest transaction.',
    status: 200,
  })
  @Get('acquire')
  async getAcquire(): Promise<VaultAcquireResponse[]> {
    return this.vaultsService.getAcquire();
  }

  @ApiDoc({
    summary: 'Get vault statistics for landing page',
    description: 'Returns statistics about active vaults, total value in USD and ADA, and total contributed assets',
    status: 200,
  })
  @Get('statistics')
  async getVaultStatistics(): Promise<VaultStatisticsResponse> {
    return await this.vaultsService.getVaultStatistics();
  }

  @ApiDoc({
    summary: 'Select my draft vaults',
    description: 'Returns list of my draft vaults. Supports sorting by name, created_at, or updated_at.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my/drafts')
  getMyDraftVaults(@Request() req, @Query() query: GetVaultsDto): Promise<PaginatedResponseDto<VaultShortResponse>> {
    const userId = req.user.sub;
    return this.draftVaultsService.getMyDraftVaults(userId, query.page, query.limit, query.sortBy, query.sortOrder);
  }

  @ApiDoc({
    summary: 'Get one vault',
    description: 'Returns vault if user is the owner. Uses draft service for draft vaults.',
    status: 200,
  })
  @UseGuards(OptionalAuthGuard)
  @Get(':id')
  async getVaultById(@Param('id') id: string, @Request() req): Promise<VaultFullResponse | Record<string, unknown>> {
    const userId = req.user?.sub;

    if (!userId) {
      return this.vaultsService.getVaultById(id);
    }

    try {
      return await this.draftVaultsService.getDraftVaultById(id, userId);
    } catch (error) {
      if (error?.message === 'Draft vault not found') {
        return this.vaultsService.getVaultById(id, userId);
      }
      throw error;
    }
  }

  @ApiDoc({
    summary: 'Get vault transactions',
    description: 'Returns list of vault transactions. By default shows only confirmed transactions.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get(':id/transactions')
  async getVaultTransactions(@Param('id') id: string, @Query() query: GetVaultTransactionsDto): Promise<Transaction[]> {
    // Verify vault exists and user has access
    await this.vaultsService.getVaultById(id);
    return this.transactionsService.getVaultTransactions(id, query.status, query.type);
  }

  @ApiDoc({
    summary: 'Build burn transaction',
    description: 'Builds a burn transaction for the specified vault and returns the presigned transaction.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post(':id/burn/build')
  async burnVaultAttempt(
    @Param('id') id: string,
    @Request() req: AuthRequest
  ): Promise<{
    txId: string;
    presignedTx: string;
  }> {
    return await this.vaultsService.buildBurnTransaction(id, req.user.sub);
  }

  @ApiDoc({
    summary: 'Publish burn tx',
    description: 'Publishes a signed burn transaction for the specified vault.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post(':id/burn/publish')
  async burnPublishAtempt(
    @Param('id') id: string,
    @Body() publishDto: PublishVaultDto,
    @Request() req: AuthRequest
  ): Promise<{
    txHash: string;
  }> {
    const userId = req.user.sub;
    return await this.vaultsService.publishBurnTransaction(id, userId, publishDto);
  }
}
