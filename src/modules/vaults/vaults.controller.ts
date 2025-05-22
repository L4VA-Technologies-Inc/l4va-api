import {Controller, Post, Body, Get, Param, Request, UseGuards, Query} from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { DraftVaultsService } from './draft-vaults.service';
import { AuthGuard } from '../auth/auth.guard';
import { CreateVaultReq } from './dto/createVault.req';
import { ApiTags } from '@nestjs/swagger';
import { ApiDoc } from '../../decorators/api-doc.decorator';
import { SaveDraftReq } from './dto/saveDraft.req';
import { GetVaultsDto } from './dto/get-vaults.dto';
import { Logger } from '@nestjs/common';
import { TransactionsService } from '../transactions/transactions.service';
import { GetVaultTransactionsDto } from './dto/get-vault-transactions.dto';
import { PublishVaultDto } from './dto/publish-vault.dto';

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
    data: CreateVaultReq,
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
  async publishVault(
    @Request() req,
    @Body() publishDto: PublishVaultDto,
  ): Promise<any> {
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
    data: SaveDraftReq,
  ) {
    const userId = req.user.sub;
    this.logger.log('drfat data ', data);
    return this.draftVaultsService.saveDraftVault(userId, data);
  }

  @ApiDoc({
    summary: 'Select my vaults',
    description: 'Returns list of my vaults. Can be filtered by status: open (published, contribution, acquire) or locked. Supports sorting by name, created_at, or updated_at.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  getMyVaults(@Request() req, @Query() query: GetVaultsDto) {
    const userId = req.user.sub;
    return this.vaultsService.getMyVaults(
      userId,
      query.filter,
      query.page,
      query.limit,
      query.sortBy,
      query.sortOrder
    );
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
    return this.draftVaultsService.getMyDraftVaults(
      userId,
      query.page,
      query.limit,
      query.sortBy,
      query.sortOrder
    );
  }

  @ApiDoc({
    summary: 'Get one vault',
    description: 'Returns vault if user is the owner. Uses draft service for draft vaults.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get(':id')
  async getVaultById(@Param('id') id: string, @Request() req) {
    const userId = req.user.sub;
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
    summary: 'List of public vaults',
    description: 'Returns paginated list of all published vaults. Default page: 1, default limit: 10. Supports sorting by name, created_at, or updated_at. Response includes total count and total pages.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get()
  getVaults(@Query() query: GetVaultsDto, @Request() req) {
    const userId = req.user.sub;

    return this.vaultsService.getVaults(
      userId,
      query.filter,
      query.page,
      query.limit,
      query.sortBy,
      query.sortOrder
    );
  }

  @ApiDoc({
    summary: 'Get vault transactions',
    description: 'Returns list of vault transactions. By default shows only confirmed transactions.',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get(':id/transactions')
  async getVaultTransactions(
    @Param('id') id: string,
    @Query() query: GetVaultTransactionsDto,
    @Request() req
  ) {
    const userId = req.user.sub;
    // Verify vault exists and user has access
    await this.vaultsService.getVaultById(id, userId);
    console.log('query status ', query);
    return this.transactionsService.getVaultTransactions(id, query.status, query.type);
  }
}

