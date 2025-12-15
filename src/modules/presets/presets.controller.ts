import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { AuthRequest } from '../auth/dto/auth-user.interface';

import { CreatePresetReq } from './dto/createPreset.req';
import { PresetsService } from './presets.service';

import { VaultPreset } from '@/database/vaultPreset.entity';

@ApiTags('presets')
@Controller('presets')
export class PresetsController {
  constructor(private readonly presetsService: PresetsService) {}

  @ApiDoc({
    summary: 'Get all presets',
    description: "Returns the user's presets",
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get()
  async getAllPresets(@Request() req: AuthRequest): Promise<VaultPreset[]> {
    const userId = req.user.sub;
    return this.presetsService.getAllPresets(userId);
  }

  @ApiDoc({
    summary: 'Create preset',
    description: 'Creates a new preset for the authenticated user',
    status: 201,
  })
  @UseGuards(AuthGuard)
  @Post()
  createPreset(@Request() req: AuthRequest, @Body() data: CreatePresetReq): Promise<VaultPreset> {
    const userId = req.user.sub;
    return this.presetsService.createPreset(userId, data);
  }

  @ApiDoc({
    summary: 'Delete custom preset',
    description: 'Deletes a preset owned by the authenticated user',
    status: 204,
  })
  @UseGuards(AuthGuard)
  @Delete(':presetId')
  @HttpCode(204)
  deletePreset(@Request() req: AuthRequest, @Param('presetId', new ParseUUIDPipe()) presetId: string): Promise<void> {
    const userId = req.user.sub;
    return this.presetsService.deletePreset(userId, presetId);
  }
}
