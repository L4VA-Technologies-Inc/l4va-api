import { Controller, Post, Body, Get, Param, Request, UseGuards, Query } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { AuthGuard } from '../auth/auth.guard';
import {CreateVaultReq} from "./dto/createVault.req";
import { ApiTags} from "@nestjs/swagger";
import {ApiDoc} from "../../decorators/api-doc.decorator";
import {SaveDraftReq} from "./dto/saveDraft.req";
import {PaginationDto} from "./dto/pagination.dto";
import {GetVaultsDto} from "./dto/get-vaults.dto";

@ApiTags('vaults')
@Controller('vaults')
export class VaultsController {
  constructor(private readonly vaultsService: VaultsService) {}

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
    return this.vaultsService.saveDraftVault(userId, data);
  }

  @ApiDoc({
    summary: 'Select my vaults',
    description: 'Returns list of my vaults. Can be filtered by status: open (published, contribution, investment) or locked',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  getMyVaults(@Request() req, @Query() query: GetVaultsDto) {
    const userId = req.user.sub;
    return this.vaultsService.getMyVaults(userId, query.filter, query.page, query.limit);
  }

  @ApiDoc({
    summary: 'Select my draft vaults',
    description: 'Returns list of my draft vaults',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my/drafts')
  getMyDraftVaults(@Request() req, @Query() query: PaginationDto) {
    const userId = req.user.sub;
    return this.vaultsService.getMyDraftVaults(userId, query.page, query.limit);
  }

  @ApiDoc({
    summary: 'Get one vault',
    description: 'Returns vault if user is the owner',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get(':id')
  getVaultById(@Param('id') id: string, @Request() req) {
    const userId = req.user.sub;
    return this.vaultsService.getVaultById(id, userId);
  }

  @ApiDoc({
    summary: 'List of vaults',
    description: 'Returns list of vaults owned by the authenticated user',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get()
  getVaults(@Request() req) {
    const userId = req.user.sub;
    return this.vaultsService.getVaults(userId);
  }
}
