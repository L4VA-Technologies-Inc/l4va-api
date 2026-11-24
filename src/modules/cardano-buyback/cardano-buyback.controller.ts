import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { BuybackCycleResult, CardanoBuybackService } from './cardano-buyback.service';
import { FundBuybackDto } from './dto/fund-buyback.dto';

import { AdminGuard } from '@/modules/auth/admin.guard';

@ApiTags('cardano-buyback')
@Controller('cardano-buyback')
@UseGuards(AdminGuard)
@ApiSecurity('Admin-Token')
export class CardanoBuybackController {
  constructor(private readonly buybackService: CardanoBuybackService) {}

  @Get('status')
  @ApiOperation({ summary: 'Buyback wallet balances, config and the next cycle action (admin only)' })
  async getStatus(): Promise<Record<string, unknown>> {
    return this.buybackService.getStatus();
  }

  @Post('run')
  @ApiOperation({
    summary: 'Run one buyback cycle now (admin only)',
    description:
      'Distributes L4VA held by the buyback wallet (burn / treasury / ops), otherwise swaps spendable ADA to L4VA.',
  })
  async run(): Promise<BuybackCycleResult> {
    return this.buybackService.runCycle();
  }

  @Post('fund')
  @ApiOperation({ summary: 'Move ADA from the admin wallet into the buyback wallet (admin only)' })
  async fund(@Body() body: FundBuybackDto): Promise<{ txHash: string }> {
    return this.buybackService.fund(BigInt(body.lovelace));
  }
}
