import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { PresaleService, type PresaleState, type PurchaseFeed } from './presale.service';

/**
 * Cached read surface for the L4VAPresale contract. Backs the l4va-org landing
 * page so browsers never hit the chain RPC directly. Both routes serve an
 * in-memory snapshot refreshed by PresaleService on a cron.
 */
@Controller('presale')
@ApiTags('Presale')
export class PresaleController {
  constructor(private readonly presaleService: PresaleService) {}

  @Get('state')
  @ApiDoc({
    summary: 'Cached presale contract state',
    description: 'Phase, caps, prices and per-wallet limits. uint256 values are decimal strings.',
    status: 200,
  })
  @Header('Cache-Control', 'public, max-age=5, stale-while-revalidate=30')
  getState(): PresaleState {
    return this.presaleService.getState();
  }

  @Get('purchases')
  @ApiDoc({
    summary: 'Recent TokensPurchased events',
    description: 'Most recent purchases (capped) plus all-time L4VA/ETH totals.',
    status: 200,
  })
  @Header('Cache-Control', 'public, max-age=10, stale-while-revalidate=30')
  getPurchases(): PurchaseFeed {
    return this.presaleService.getPurchases();
  }
}
