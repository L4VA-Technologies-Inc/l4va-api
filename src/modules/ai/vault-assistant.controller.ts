import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { GenerateVaultImageReq, GenerateVaultImageRes } from './dto/generate-vault-image.dto';
import { GetVaultCreationSpecDto } from './dto/get-vault-creation-spec.dto';
import { VaultAssistantMessageReq } from './dto/vault-assistant-message.req';
import { VaultAssistantMessageRes } from './dto/vault-assistant-message.res';
import { resolveVaultCreationSpec } from './spec/resolve-spec';
import { ResolvedVaultCreationSpec, SpecChain } from './spec/spec.types';
import { VaultAssistantService } from './vault-assistant.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('ai')
@Controller('ai')
export class VaultAssistantController {
  constructor(private readonly vaultAssistantService: VaultAssistantService) {}

  @ApiDoc({
    summary: 'Get the vault creation spec',
    description: 'Chain- and network-resolved field bounds the AI assistant is constrained to',
    status: 200,
  })
  @Get('vault-creation-spec')
  getVaultCreationSpec(@Query() query: GetVaultCreationSpecDto): ResolvedVaultCreationSpec {
    return resolveVaultCreationSpec(query.chain as SpecChain, query.network);
  }

  @ApiDoc({
    summary: 'Send a message to the vault creation assistant',
    description: 'Returns the assistant reply plus a sanitized partial vault draft',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('vault-assistant/message')
  sendMessage(@Request() req: AuthRequest, @Body() body: VaultAssistantMessageReq): Promise<VaultAssistantMessageRes> {
    return this.vaultAssistantService.respond(req.user.sub, body);
  }

  @ApiDoc({
    summary: 'Generate a vault image',
    description: 'Generates a 640x640 image from the prompt and stores it in the bucket',
    status: 201,
  })
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('vault-assistant/image')
  generateImage(@Body() body: GenerateVaultImageReq): Promise<GenerateVaultImageRes> {
    return this.vaultAssistantService.generateImage(body.prompt);
  }
}
