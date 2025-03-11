import { Controller, Post, Body, Get, Param, Request, UseGuards } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { AuthGuard } from '../auth/auth.guard';
import {CreateVaultReq} from "./dto/createVault.req";
import { ApiTags} from "@nestjs/swagger";
import {ApiDoc} from "../../decorators/api-doc.decorator";
import {SaveDraftReq} from "./dto/saveDraft.req";

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
    summary: 'Select my vault',
    description: 'Selected my vault',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  getMyVaults(@Request() req) {
    const userId = req.user.sub;
    return this.vaultsService.getMyVaults(userId);
  }

  @ApiDoc({
    summary: 'Get one vault',
    description: 'Vault has found and returned',
    status: 200,
  })
  @Get(':id')
  getVaultById(@Param('id') id: string) {
    return this.vaultsService.getVaultById(id);
  }

  @ApiDoc({
    summary: 'List of vault',
    description: 'Selected list of vaults',
    status: 200,
  })
  @Get()
  getVaults() {
    return this.vaultsService.getVaults();
  }
}
