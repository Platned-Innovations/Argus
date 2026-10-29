import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FindingsModule } from '../findings/findings.module';
import { ChannelsService } from '../integrations/channels.service';
import { JiraService } from '../integrations/jira.service';
import { NotificationsService } from '../integrations/notifications.service';
import { IntegrationsController, TicketingSettingsController, TicketsController } from './tickets.controller';
import { TicketAiService } from './ticket-ai.service';
import { TicketsService } from './tickets.service';

/** Tickets and everything that acts on them: email, Jira, notification rules and AI assistance. */
@Module({
  imports: [FindingsModule, AiModule],
  controllers: [TicketsController, IntegrationsController, TicketingSettingsController],
  providers: [TicketsService, TicketAiService, ChannelsService, JiraService, NotificationsService],
  exports: [TicketsService],
})
export class TicketsModule {}
