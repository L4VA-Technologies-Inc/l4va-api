import { Controller, Post, Body, Get, Param, Request, UseGuards, Query, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

import { DraftVaultsService } from './draft-vaults.service';
import { CreateVaultReq } from './dto/createVault.req';
import { GetVaultTransactionsDto } from './dto/get-vault-transactions.dto';
import { GetVaultsDto } from './dto/get-vaults.dto';
import { PublishVaultDto } from './dto/publish-vault.dto';
import { SaveDraftReq } from './dto/saveDraft.req';
import { TransactionsService } from './processing-tx/offchain-tx/transactions.service';
import { VaultsService } from './vaults.service';

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
    @Request() req,
    @Body()
    data: CreateVaultReq
  ) {
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
  async publishVault(@Request() req, @Body() publishDto: PublishVaultDto): Promise<any> {
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
    @Request() req,
    @Body()
    data: SaveDraftReq
  ) {
    const userId = req.user.sub;
    this.logger.log('drfat data ', data);
    return this.draftVaultsService.saveDraftVault(userId, data);
  }

  @ApiDoc({
    summary: 'Select my vaults',
    description:
      'Returns list of my vaults. Can be filtered by status: open (published, contribution, acquire) or locked. Supports sorting by name, created_at, or updated_at.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  getMyVaults(@Request() req, @Query() query: GetVaultsDto) {
    const userId = req.user.sub;
    return this.vaultsService.getMyVaults(userId, query.filter, query.page, query.limit, query.sortBy, query.sortOrder);
  }

  @ApiDoc({
    summary: 'List of biggest investments',
    description: 'Returns list of biggest transaction.',
    status: 200,
  })
  @Get('acquire')
  async getAcquire(@Request() req, @Query() query: any) {
    return this.vaultsService.getAcquire(); 
  }


  @ApiDoc({
    summary: 'Select my draft vaults',
    description: 'Returns list of my draft vaults. Supports sorting by name, created_at, or updated_at.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my/drafts')
  getMyDraftVaults(@Request() req, @Query() query: GetVaultsDto) {
    const userId = req.user.sub;
    return this.draftVaultsService.getMyDraftVaults(userId, query.page, query.limit, query.sortBy, query.sortOrder);
  }

  @ApiDoc({
    summary: 'Get one vault',
    description: 'Returns vault if user is the owner. Uses draft service for draft vaults.',
    status: 200,
  })
  @Get(':id')
  async getVaultById(@Param('id') id: string, @Request() req) {
    const userId = req.user?.sub;

    if (!userId) {
      // If user is not authenticated, return public vault
      return this.vaultsService.getVaultById(id);
    }

    try {
      return await this.draftVaultsService.getDraftVaultById(id, userId);
    } catch (error) {
      if (error?.message === 'Draft vault not found') {
        return this.vaultsService.getVaultById(id);
      }
      throw error;
    }
  }

  @ApiDoc({
    summary: 'List of public vaults',
    description:
      'Returns paginated list of all published vaults. Default page: 1, default limit: 10. Supports sorting by name, created_at, or updated_at. Response includes total count and total pages.',
    status: 200,
  })
  @Get()
  getVaults(@Query() query: GetVaultsDto, @Request() req) {
    const userId = req.user?.sub;

    return this.vaultsService.getVaults(userId, query.filter, query.page, query.limit, query.sortBy, query.sortOrder);
  }

  @ApiDoc({
    summary: 'Get vault transactions',
    description: 'Returns list of vault transactions. By default shows only confirmed transactions.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get(':id/transactions')
  async getVaultTransactions(@Param('id') id: string, @Query() query: GetVaultTransactionsDto) {
    // Verify vault exists and user has access
    await this.vaultsService.getVaultById(id);
    return this.transactionsService.getVaultTransactions(id, query.status, query.type);
  }

  @ApiDoc({
    summary: 'Burn vault',
    description: 'Returns list of vault transactions. By default shows only confirmed transactions.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('burn-build/:id')
  async burnVaultAttempt(@Param('id') id: string, @Query() query: GetVaultTransactionsDto, @Request() req) {
    const userId = req.user.sub;
    return await this.vaultsService.burnVaultAttempt(id, userId);
  }

  @ApiDoc({
    summary: 'Burn vault',
    description: 'Returns list of vault transactions. By default shows only confirmed transactions.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('burn-publish/:id')
  async burnPublishAtempt(
    @Param('id') id: string,
    @Query() query: GetVaultTransactionsDto,
    @Body() publishDto: PublishVaultDto,
    @Request() req
  ) {
    const userId = req.user.sub;

    return await this.vaultsService.burnVaultPublishTx(id, userId, publishDto);
  }
}
