import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SystemSettingsResponseDto } from './dto/settings-response.dto';
import { SystemSettingsService } from './system-settings.service';

import { AdminGuard } from '@/modules/auth/admin.guard';

@ApiTags('System Settings')
@Controller('system-settings')
@UseGuards(AdminGuard)
@ApiBearerAuth()
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Post('reload')
  @ApiOperation({
    summary: 'Reload settings from database (useful after manual DB updates)',
  })
  @ApiResponse({
    status: 200,
    description: 'Settings reloaded from database',
    type: SystemSettingsResponseDto,
  })
  async reloadSettings(): Promise<SystemSettingsResponseDto> {
    return await this.systemSettingsService.reloadSettings();
  }
}
