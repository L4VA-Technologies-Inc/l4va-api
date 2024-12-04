import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Vaults')
@Controller('vaults')
export class VaultController {
  @Get()
  @ApiOperation({ summary: 'Retrieve all vaults' })
  @ApiResponse({ status: 200, description: 'List of all vaults' })
  getAllVaults() {
    return [];
  }

  @Post()
  @ApiOperation({ summary: 'Create a new vault' })
  @ApiResponse({ status: 201, description: 'Vault created successfully' })
  createVault(@Body() createVaultDto: any) {
    return { message: 'Vault created', data: createVaultDto };
  }
}
