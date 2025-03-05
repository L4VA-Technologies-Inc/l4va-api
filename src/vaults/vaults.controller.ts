import { Controller, Post, Body, Get, Param, Request, UseGuards } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { AuthGuard } from '../auth/auth.guard';
import {CreateVaultReq} from "./dto/createVault.req";
import {ApiOperation, ApiResponse} from "@nestjs/swagger";

@Controller('vaults')
export class VaultsController {
  constructor(private readonly vaultsService: VaultsService) {}

  @ApiOperation({ summary: 'Create vault' })
  @ApiResponse({
    status: 200,
    description: 'Vault successfully created',
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

  @UseGuards(AuthGuard)
  @Get('my')
  getMyVaults(@Request() req) {
    const userId = req.user.sub;
    return this.vaultsService.getMyVaults(userId);
  }

  @Get(':id')
  getVaultById(@Param('id') id: string) {
    return this.vaultsService.getVaultById(id);
  }

  @Get()
  getVaults() {
    return this.vaultsService.getVaults();
  }
}
