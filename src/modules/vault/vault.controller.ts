import { Controller, Get, Post, Body, Version } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { VaultService } from './vault.service';
import { CreateVaultDto } from '../../dto/create-vault.dto';
import { VaultResponseDto } from '../../dto/vault-response.dto';

@ApiTags('Vaults')
@Controller('vaults')
export class VaultController {
  constructor(private readonly vaultService: VaultService) {}

  @Version('1')
  @Get()
  @ApiOperation({ summary: 'Retrieve all vaults' })
  @ApiResponse({ status: 200, description: 'List of all vaults', type: [VaultResponseDto] })
  async getAllVaults(): Promise<VaultResponseDto[]> {
    return this.vaultService.getAllVaults();
  }

  @Version('1')
  @Post()
  @ApiOperation({ summary: 'Create a new vault' })
  @ApiResponse({ status: 201, description: 'Vault created successfully', type: VaultResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  async createVault(@Body() createVaultDto: CreateVaultDto): Promise<VaultResponseDto> {
    return this.vaultService.createVault(createVaultDto);
  }
}
