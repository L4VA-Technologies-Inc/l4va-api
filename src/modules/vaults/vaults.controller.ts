import { Controller, Post, Body, Get, Param, Request, UseGuards, Query, ValidationPipe } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { DraftVaultsService } from './draft-vaults.service';
import { AuthGuard } from '../auth/auth.guard';
import { CreateVaultReq } from "./dto/createVault.req";
import { ApiTags } from "@nestjs/swagger";
import { ApiDoc } from "../../decorators/api-doc.decorator";
import { SaveDraftReq } from "./dto/saveDraft.req";
import { PaginationDto } from "./dto/pagination.dto";
import { GetVaultsDto } from "./dto/get-vaults.dto";

@ApiTags('vaults')
@Controller('vaults')
export class VaultsController {
  constructor(
    private readonly vaultsService: VaultsService,
    private readonly draftVaultsService: DraftVaultsService
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
    console.log('drfat data ', data)
    return this.draftVaultsService.saveDraftVault(userId, data);
  }

  @ApiDoc({
    summary: 'Select my vaults',
    description: 'Returns list of my vaults. Can be filtered by status: open (published, contribution, investment) or locked. Supports sorting by name, created_at, or updated_at.',
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
  @Get()
  getVaults(@Query() query: GetVaultsDto) {
    return this.vaultsService.getVaults(
      query.filter,
      query.page,
      query.limit,
      query.sortBy,
      query.sortOrder
    );
  }
}
