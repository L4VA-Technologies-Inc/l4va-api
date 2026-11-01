import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SupportDiscordService } from './support-discord.service';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

import { SupportMessage } from '@/database/support-message.entity';
import { SupportTicket } from '@/database/support-ticket.entity';
import { User } from '@/database/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SupportTicket, SupportMessage, User])],
  controllers: [SupportController],
  providers: [SupportService, SupportDiscordService],
})
export class SupportModule {}
