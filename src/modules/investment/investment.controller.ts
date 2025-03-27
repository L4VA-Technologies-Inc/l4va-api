import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InvestmentService } from './investment.service';
import { InvestReq } from './dto/invest.req';
import { AuthGuard } from '../auth/auth.guard';

@ApiTags('Investments')
@Controller('investments')
export class InvestmentController {
  constructor(private readonly investmentService: InvestmentService) {}

  @Post(':vaultId')
  @ApiOperation({ summary: 'Invest in a vault' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 201, description: 'Investment successful' })
  async invest(
    @Req() req,
    @Param('vaultId') vaultId: string,
    @Body() investReq: InvestReq,
  ) {
    const userId = req.user.sub;
    return this.investmentService.invest(vaultId, investReq, userId);
  }
}
