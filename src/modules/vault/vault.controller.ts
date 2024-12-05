import { Controller, Get, Post, Body, Version } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { Vault } from '../../entities/vault.entity';
import { VaultRepository } from '../repository/vault.repository';
import { CreateVaultDto } from '../../dto/create-vault.dto';

@ApiTags('Vaults')
@Controller('vaults')
export class VaultController {
  constructor(private readonly vaultRepository: VaultRepository) {}

  @Version('1')
  @Get()
  @ApiOperation({ summary: 'Retrieve all vaults' })
  @ApiResponse({ status: 200, description: 'List of all vaults' })
  async getAllVaults(): Promise<Vault[]> {
    return await this.vaultRepository.findAll();
  }

  @Version('1')
  @Post()
  @ApiOperation({ summary: 'Create a new vault' })
  @ApiResponse({ status: 201, description: 'Vault created successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  async createVault(@Body() createVaultDto: CreateVaultDto): Promise<Vault> {
    const newVault = await this.vaultRepository.createVault(createVaultDto);
    return newVault;
  }
}
