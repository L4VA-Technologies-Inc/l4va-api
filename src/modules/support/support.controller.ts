import { Body, HttpCode, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CreateSupportRequestReq } from './dto/create-support-request.req';
import { SupportService } from './support.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';

// Behind nginx without `trust proxy`, req.ip is the proxy — use the forwarded client IP.
const clientIp = (req: AuthRequest): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const realIp = req.headers['x-real-ip'];
  return first || (Array.isArray(realIp) ? realIp[0] : realIp) || req.ip || 'unknown';
};

@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @ApiDoc({
    summary: 'Send a support request',
    description: 'Open to anyone; forwarded to the team Discord support channel. Rate limited per IP.',
    status: 204,
  })
  @UseGuards(OptionalAuthGuard)
  @HttpCode(204)
  @Post()
  async create(@Request() req: AuthRequest, @Body() body: CreateSupportRequestReq): Promise<void> {
    await this.supportService.createRequest(body, clientIp(req), req.user);
  }
}
