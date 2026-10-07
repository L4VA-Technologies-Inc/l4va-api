import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { EvmLiquidityService, type EvmVaultLpView } from './evm-liquidity.service';

@ApiTags('EVM liquidity')
@Controller('vaults')
export class EvmLiquidityController {
  constructor(private readonly liquidityService: EvmLiquidityService) {}

  @Get(':id/lp')
  @ApiOperation({
    summary: 'EVM vault liquidity pool',
    description: 'Pool seeded when the raise closed: pair address, live reserves, VT price and the vault LP share.',
  })
  async getVaultLp(@Param('id', ParseUUIDPipe) vaultId: string): Promise<EvmVaultLpView> {
    const lp = await this.liquidityService.getVaultLp(vaultId);
    if (!lp) throw new NotFoundException('Vault has no liquidity pool');
    return lp;
  }
}
