import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { CompetitionService, LeaderboardResponse } from './competition.service';

@Controller('competition')
@ApiTags('Competition')
export class CompetitionController {
  constructor(private readonly competitionService: CompetitionService) {}

  @Get('leaderboard')
  @ApiDoc({
    summary: 'Creator Challenge leaderboard',
    description: 'Season timeline plus token and portfolio rankings computed from hourly snapshots',
    status: 200,
  })
  async getLeaderboard(@Query('season') season?: string): Promise<LeaderboardResponse> {
    return this.competitionService.getLeaderboard(season);
  }
}
