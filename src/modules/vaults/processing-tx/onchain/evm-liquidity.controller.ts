import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { EvmLiquidityService, type EvmVaultLpView } from './evm-liquidity.service';

import { PriceService } from '@/modules/price/price.service';

@ApiTags('EVM liquidity')
@Controller('vaults')
export class EvmLiquidityController {
  constructor(
    private readonly liquidityService: EvmLiquidityService,
    private readonly priceService: PriceService
  ) {}

  @Get(':id/lp')
  @ApiOperation({
    summary: 'EVM vault liquidity pool',
    description:
      'Pool seeded when the raise closed: pair address, live reserves, VT price, the vault LP share and its value. ' +
      '`prices` (USD per ETH / ADA) lets the client show native amounts in the selected currency.',
  })
  async getVaultLp(
    @Param('id', ParseUUIDPipe) vaultId: string
  ): Promise<EvmVaultLpView & { prices: { ethUsd: number; adaUsd: number } }> {
    const lp = await this.liquidityService.getVaultLp(vaultId);
    if (!lp) throw new NotFoundException('Vault has no liquidity pool');
    const [ethUsd, adaUsd] = await Promise.all([this.priceService.getEthPrice(), this.priceService.getAdaPrice()]);
    return { ...lp, prices: { ethUsd, adaUsd } };
  }
}
