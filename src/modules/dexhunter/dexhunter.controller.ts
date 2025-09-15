import {
  Controller,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DexHunterService } from './dexhunter.service';
import { ApiDoc } from '@/decorators/api-doc.decorator';

@ApiTags('dex')
@Controller('dex')
export class DexHunterController {
  constructor(private readonly dexHunterService: DexHunterService) {}

 
  @Post('sell')
  async sell() {
    return this.dexHunterService.sell();
  }

}
