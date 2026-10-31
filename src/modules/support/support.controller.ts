import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { OpenSupportTicketReq, SendSupportMessageReq } from './dto/support-ticket.req';
import { SupportTicketRes } from './dto/support-ticket.res';
import { SupportService } from './support.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('support')
@Controller('support')
@UseGuards(AuthGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @ApiDoc({
    summary: 'Current support chat',
    description: "The user's open support chat, or their latest one, with messages. Polled by the app.",
    status: 200,
  })
  @Get('ticket')
  async getLatest(@Request() req: AuthRequest): Promise<{ ticket: SupportTicketRes | null }> {
    return { ticket: await this.supportService.getLatestTicket(req.user.sub) };
  }

  @ApiDoc({
    summary: 'Start a support chat',
    description: 'Opens a private ticket channel in the team Discord, or adds the message to the open chat.',
    status: 201,
  })
  @Post('ticket')
  async open(@Request() req: AuthRequest, @Body() body: OpenSupportTicketReq): Promise<{ ticket: SupportTicketRes }> {
    return { ticket: await this.supportService.openTicket(req.user, body) };
  }

  @ApiDoc({ summary: 'Send a message to a support chat', description: 'Mirrored to the Discord ticket.', status: 201 })
  @Post('ticket/:id/messages')
  async send(
    @Request() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendSupportMessageReq
  ): Promise<{ ticket: SupportTicketRes }> {
    return { ticket: await this.supportService.sendMessage(req.user, id, body) };
  }

  @ApiDoc({ summary: 'Close a support chat', description: 'The team is notified in Discord.', status: 200 })
  @HttpCode(200)
  @Post('ticket/:id/close')
  async close(
    @Request() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<{ ticket: SupportTicketRes }> {
    return { ticket: await this.supportService.closeByUser(req.user, id) };
  }
}
