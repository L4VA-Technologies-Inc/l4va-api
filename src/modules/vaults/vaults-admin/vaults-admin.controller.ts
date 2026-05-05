import { Controller, Get, Logger, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { Vault } from '@/database/vault.entity';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { PaginatedResponseDto } from '@/modules/vaults/dto/paginated-response.dto';
import { VaultsAdminService } from '@/modules/vaults/vaults-admin/vaults-admin.service';

@ApiTags('vaults-admin')
@Controller('vaults-admin')
@UseGuards(AdminGuard)
@ApiSecurity('Admin-Token')
export class VaultsAdminController {
  private readonly logger = new Logger(VaultsAdminController.name);
  constructor(private readonly vaultsAdminService: VaultsAdminService) {}

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
}
