import {Body, Controller, Param, Post, Req, UseGuards} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ContributionService } from './contribution.service';
import { ContributeReq } from './dto/contribute.req';
import {AuthGuard} from "../auth/auth.guard";


@ApiTags('Contributions')
@Controller('contributions')
export class ContributionController {
  constructor(private readonly contributionService: ContributionService) {}

  @Post(':vaultId')
  @ApiOperation({ summary: 'Contribute to a vault' })
  @UseGuards(AuthGuard)
  @ApiResponse({ status: 201, description: 'Contribution successful' })
  async contribute(
    @Req() req,
    @Param('vaultId') vaultId: string,
    @Body() contributeReq: ContributeReq
  ) {
    const userId = req.user.sub;
    return this.contributionService.contribute(vaultId, contributeReq, userId);
  }
}
