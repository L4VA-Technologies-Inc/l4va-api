import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PriceService } from './price.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';

@ApiTags('price')
@Controller('price')
export class PriceController {
  constructor(private readonly priceService: PriceService) {}

  @ApiDoc({
    summary: 'Native token prices in USD',
    description: 'Cached ADA and ETH prices, used to enter USD amounts in the create-vault form',
    status: 200,
  })
  @Get('native')
  async getNativePrices(): Promise<{ adaUsd: number; ethUsd: number }> {
    const [adaUsd, ethUsd] = await Promise.all([this.priceService.getAdaPrice(), this.priceService.getEthPrice()]);
    return { adaUsd, ethUsd };
  }
}
