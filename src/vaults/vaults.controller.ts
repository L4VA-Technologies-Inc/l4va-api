import { Controller, Post, Body, Get, Param, Request, UseGuards } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('vaults')
export class VaultsController {
  constructor(private readonly vaultsService: VaultsService) {}

  @UseGuards(AuthGuard)
  @Post()
  createVault(
    @Request() req,
    @Body()
    data: {
      name: string;
      type: 'single' | 'multi' | 'cnt';
      privacy: 'private' | 'public' | 'semi-private';
      brief?: string;
      imageUrl?: string;
      bannerUrl?: string;
      socialLinks?: { facebook?: string; twitter?: string };
    },
  ) {
    const userId = req.user.sub;
    return this.vaultsService.createVault(userId, data);
  }

  @UseGuards(AuthGuard)
  @Get('my')
  getMyVaults(@Request() req) {
    const userId = req.user.sub;
    return this.vaultsService.getMyVaults(userId);
  }

  @Get(':id')
  getVaultById(@Param('id') id: number) {
    return this.vaultsService.getVaultById(id);
  }

  @Get()
  getVaults() {
    return this.vaultsService.getVaults();
  }
}
