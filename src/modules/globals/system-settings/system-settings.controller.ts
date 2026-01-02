import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SystemSettingsResponseDto } from './dto/settings-response.dto';
import { UpdateSystemSettingsDto } from './dto/update-settings.dto';
import { SystemSettingsService } from './system-settings.service';

import { AuthGuard } from '@/modules/auth/auth.guard';

@ApiTags('System Settings')
@Controller('system-settings')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class SystemSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get current system settings' })
  @ApiResponse({
    status: 200,
    description: 'Current system settings',
    type: SystemSettingsResponseDto,
  })
  getSettings(): SystemSettingsResponseDto {
    return this.systemSettingsService.getSettings();
  }

  @Patch()
  @ApiOperation({ summary: 'Update system settings' })
  @ApiResponse({
    status: 200,
    description: 'Updated system settings',
    type: SystemSettingsResponseDto,
  })
  async updateSettings(@Body() data: UpdateSystemSettingsDto): Promise<SystemSettingsResponseDto> {
    return await this.systemSettingsService.updateSettings(data);
  }

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
