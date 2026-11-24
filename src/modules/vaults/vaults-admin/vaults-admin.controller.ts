import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { Vault } from '@/database/vault.entity';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { PaginatedResponseDto } from '@/modules/vaults/dto/paginated-response.dto';
import { EvmRescueService, type RescuePreview } from '@/modules/vaults/processing-tx/onchain/evm-rescue.service';
import { RescueUntrackedDto } from '@/modules/vaults/vaults-admin/dto/rescue-untracked.dto';
import { VaultsAdminService } from '@/modules/vaults/vaults-admin/vaults-admin.service';

@ApiTags('vaults-admin')
@Controller('vaults-admin')
@UseGuards(AdminGuard)
@ApiSecurity('Admin-Token')
export class VaultsAdminController {
  constructor(
    private readonly vaultsAdminService: VaultsAdminService,
    private readonly evmRescueService: EvmRescueService
  ) {}

  @ApiOperation({ summary: 'Get vaults available for admin cancellation' })
  @Get('cancelable')
  async getVaultToCancelByAdmin(
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number
  ): Promise<PaginatedResponseDto<Vault>> {
    return this.vaultsAdminService.getVaultToCancelByAdmin(search, Number(page) || 1, Number(limit) || 10);
  }

  @ApiOperation({ summary: 'Cancel vault by admin' })
  @Post(':id/cancel')
  async cancelVaultByAdmin(@Param('id', new ParseUUIDPipe()) vaultId: string): Promise<{ success: boolean }> {
    return this.vaultsAdminService.cancelVaultByAdmin(vaultId);
  }

  @ApiOperation({
    summary: 'Preview returning assets sent straight to an EVM vault',
    description:
      'Lists every transfer into the vault in `txHash`, with its one-time sourceId and whether it can be returned to ' +
      'its sender. `supported` is false for vaults created before rescue existed.',
  })
  @Get(':id/rescue')
  async previewRescue(
    @Param('id', new ParseUUIDPipe()) vaultId: string,
    @Query('txHash') txHash: string
  ): Promise<RescuePreview> {
    return this.evmRescueService.preview(vaultId, txHash);
  }

  @ApiOperation({
    summary: 'Return one stray transfer to its sender',
    description: 'Always pays the original sender. The vault refuses a second payout for the same transfer.',
  })
  @Post(':id/rescue')
  async rescue(
    @Param('id', new ParseUUIDPipe()) vaultId: string,
    @Body() body: RescueUntrackedDto
  ): Promise<{ txHash: string }> {
    const { txHash } = await this.evmRescueService.rescue(vaultId, body.txHash, body.logIndex, body.tokenId);
    return { txHash };
  }
}
