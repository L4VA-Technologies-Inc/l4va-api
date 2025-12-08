import { Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DexHunterService } from './dexhunter.service';

@ApiTags('dex')
@Controller('dex')
export class DexHunterController {
  constructor(private readonly dexHunterService: DexHunterService) {}

  @Post('sell')
  async sell() {
    return this.dexHunterService.sell();
  }
}
