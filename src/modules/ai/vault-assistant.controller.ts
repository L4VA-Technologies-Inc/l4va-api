import { Body, Controller, Get, Post, Query, Request, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { GenerateVaultImageReq, GenerateVaultImageRes } from './dto/generate-vault-image.dto';
import { GetVaultCreationSpecDto } from './dto/get-vault-creation-spec.dto';
import { TickerAvailabilityQuery, TickerAvailabilityRes } from './dto/ticker-availability.dto';
import { VaultAssistantMessageReq } from './dto/vault-assistant-message.req';
import { VaultAssistantMessageRes } from './dto/vault-assistant-message.res';
import { ResolvedVaultCreationSpec, SpecChain } from './spec/spec.types';
import { TickerAvailabilityService } from './ticker-availability.service';
import { VaultAssistantService } from './vault-assistant.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('ai')
@Controller('ai')
export class VaultAssistantController {
  constructor(
    private readonly vaultAssistantService: VaultAssistantService,
    private readonly tickerAvailability: TickerAvailabilityService
  ) {}

  @ApiDoc({
    summary: 'Get the vault creation spec',
    description: 'Chain- and network-resolved field bounds the AI assistant is constrained to',
    status: 200,
  })
  @Get('vault-creation-spec')
  getVaultCreationSpec(@Query() query: GetVaultCreationSpecDto): ResolvedVaultCreationSpec {
    return this.vaultAssistantService.resolveSpec(query.chain as SpecChain, query.network);
  }

  @ApiDoc({
    summary: 'Check whether a vault token ticker is free',
    description: 'Same rule createVault enforces; a taken ticker comes with the first free numbered variant',
    status: 200,
  })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('ticker-availability')
  async getTickerAvailability(@Query() query: TickerAvailabilityQuery): Promise<TickerAvailabilityRes> {
    if (!(await this.tickerAvailability.isTaken(query.ticker))) {
      return { available: true, suggestion: null };
    }
    return { available: false, suggestion: await this.tickerAvailability.firstFreeVariant(query.ticker) };
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
    summary: 'Stream a message to the vault creation assistant',
    description: 'SSE stream of message deltas, then a final done event with the sanitized vault draft',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('vault-assistant/message/stream')
  async sendMessageStream(
    @Request() req: AuthRequest,
    @Body() body: VaultAssistantMessageReq,
    @Res() res: Response
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      for await (const event of this.vaultAssistantService.respondStream(req.user.sub, body)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'error') {
          break;
        }
      }
    } catch {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'The assistant could not answer right now. Please try again.' })}\n\n`
        );
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
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
