import { Module } from '@nestjs/common';
import { FindingsModule } from '../findings/findings.module';
import { ChannelsService } from '../integrations/channels.service';
import { JiraService } from '../integrations/jira.service';
import { NotificationsService } from '../integrations/notifications.service';
import { IntegrationsController, TicketingSettingsController, TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

/** Tickets and everything that acts on them: email, Jira and notification rules. */
@Module({
  imports: [FindingsModule],
  controllers: [TicketsController, IntegrationsController, TicketingSettingsController],
  providers: [TicketsService, ChannelsService, JiraService, NotificationsService],
  exports: [TicketsService],
})
export class TicketsModule {}
