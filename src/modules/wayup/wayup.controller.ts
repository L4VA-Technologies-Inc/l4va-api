import {
  Controller,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WayUpService } from './wayup.service';
import { ApiDoc } from '@/decorators/api-doc.decorator';
import { Body } from '@nestjs/common';

@ApiTags('wayup')
@Controller('wayup')
export class WayUpController {
  constructor(private readonly wayUpService: WayUpService) {}

  @Post('sell')
  async sell(@Body() body: { policyIds?: { id: string; priceAda: number }[], address?: string }) {
    return this.wayUpService.sell(body.policyIds, body.address);
  }

}
