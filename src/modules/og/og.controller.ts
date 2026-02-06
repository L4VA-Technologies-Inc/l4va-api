import { Controller, Get, Header, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { OgService } from './og.service';

@ApiTags('og')
@Controller('og')
export class OgController {
  constructor(private readonly ogService: OgService) {}

  @ApiOperation({ summary: 'Get Open Graph meta tags for a vault' })
  @ApiParam({ name: 'vaultId', description: 'Vault UUID' })
  @Get('vaults/:vaultId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  async getVaultOg(
    @Param('vaultId', new ParseUUIDPipe()) vaultId: string,
    @Req() req: Request,
  ): Promise<string> {
    const host = req.get('host') || 'l4va.io';
    return this.ogService.getVaultOgHtml(vaultId, host);
  }
}
