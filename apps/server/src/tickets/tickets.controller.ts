import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  channelSchema,
  channelTestSchema,
  jiraSettingsSchema,
  listTicketsQuerySchema,
  notificationRuleSchema,
  ticketBulkSchema,
  ticketCommentSchema,
  ticketEmailSchema,
  ticketingSettingsSchema,
  ticketJiraSchema,
  ticketStatusSchema,
  ticketUpdateSchema,
  type TicketingSettings,
} from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { ChannelsService } from '../integrations/channels.service';
import { JiraService } from '../integrations/jira.service';
import { NotificationsService } from '../integrations/notifications.service';
import { TicketsService } from './tickets.service';

/** Outbound calls to third parties are rate limited per user IP. */
const OUTBOUND_LIMIT = { default: { limit: 20, ttl: 60_000 } };

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly notifications: NotificationsService,
    private readonly jira: JiraService,
    private readonly channels: ChannelsService,
  ) {}

  @Get()
  @RequirePermissions('tickets:read')
  list(@Query(new ZodPipe(listTicketsQuerySchema)) q: z.infer<typeof listTicketsQuerySchema>, @CurrentUser() me: RequestUser) {
    return this.tickets.list(q, me.user);
  }

  @Get('summary')
  @RequirePermissions('tickets:read')
  summary(@CurrentUser() me: RequestUser) {
    return this.tickets.summary(me.user);
  }

  @Get('export')
  @RequirePermissions('tickets:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="argus-tickets.csv"')
  export(@Query(new ZodPipe(listTicketsQuerySchema)) q: z.infer<typeof listTicketsQuerySchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.tickets.exportCsv(q, me.user, requestContext(req));
  }

  /** Email channels to choose from when emailing a ticket (names only). */
  @Get('email-channels')
  @RequirePermissions('tickets:write')
  emailChannels() {
    return this.channels.emailChannels();
  }

  @Post('bulk')
  @HttpCode(200)
  @RequirePermissions('tickets:write')
  bulk(@Body(new ZodPipe(ticketBulkSchema)) body: z.infer<typeof ticketBulkSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.tickets.bulk(body, me.user, requestContext(req));
  }

  @Get(':id')
  @RequirePermissions('tickets:read')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.tickets.detail(id, me.user);
  }

  @Get(':id/assignees')
  @RequirePermissions('tickets:write')
  assignees(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.tickets.assignees(id, me.user);
  }

  @Patch(':id')
  @RequirePermissions('tickets:write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ticketUpdateSchema)) body: z.infer<typeof ticketUpdateSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.tickets.update(id, body, me.user, requestContext(req));
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('tickets:write')
  status(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ticketStatusSchema)) body: z.infer<typeof ticketStatusSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.tickets.changeStatus(id, body, me.user, requestContext(req));
  }

  @Post(':id/comments')
  @RequirePermissions('tickets:write')
  comment(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ticketCommentSchema)) body: z.infer<typeof ticketCommentSchema>, @CurrentUser() me: RequestUser) {
    return this.tickets.comment(id, body.body, me.user);
  }

  @Put(':id/watch')
  @RequirePermissions('tickets:read')
  watch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.tickets.watch(id, me.user, true);
  }

  @Delete(':id/watch')
  @RequirePermissions('tickets:read')
  unwatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.tickets.watch(id, me.user, false);
  }

  @Post(':id/email')
  @HttpCode(200)
  @RequirePermissions('tickets:write')
  @Throttle(OUTBOUND_LIMIT)
  email(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ticketEmailSchema)) body: z.infer<typeof ticketEmailSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.notifications.emailTicket(id, body, me.user, requestContext(req));
  }

  @Post(':id/jira')
  @RequirePermissions('tickets:write')
  @Throttle(OUTBOUND_LIMIT)
  createJira(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ticketJiraSchema)) body: z.infer<typeof ticketJiraSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.jira.createIssue(id, body, me.user, requestContext(req));
  }

  @Post(':id/jira/sync')
  @HttpCode(200)
  @RequirePermissions('tickets:write')
  @Throttle(OUTBOUND_LIMIT)
  async syncJira(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    await this.jira.syncTicket(await this.tickets.require(id, me.user));
    return this.tickets.detail(id, me.user);
  }
}

@Controller('integrations')
@RequirePermissions('settings:manage')
export class IntegrationsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly jira: JiraService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('channels')
  listChannels() {
    return this.channels.list();
  }

  @Post('channels')
  createChannel(@Body(new ZodPipe(channelSchema)) body: z.infer<typeof channelSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.channels.create(body, me.user, requestContext(req));
  }

  @Put('channels/:id')
  updateChannel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(channelSchema)) body: z.infer<typeof channelSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.channels.update(id, body, me.user, requestContext(req));
  }

  @Delete('channels/:id')
  @HttpCode(200)
  async deleteChannel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.channels.remove(id, me.user, requestContext(req));
    return { ok: true };
  }

  @Post('channels/:id/test')
  @HttpCode(200)
  @Throttle(OUTBOUND_LIMIT)
  testChannel(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(channelTestSchema)) body: z.infer<typeof channelTestSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.channels.test(id, body.to, me.user, requestContext(req));
  }

  @Get('jira')
  getJira() {
    return this.jira.getSettings();
  }

  @Put('jira')
  updateJira(@Body(new ZodPipe(jiraSettingsSchema)) body: z.infer<typeof jiraSettingsSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.jira.updateSettings(body, me.user, requestContext(req));
  }

  @Post('jira/test')
  @HttpCode(200)
  @Throttle(OUTBOUND_LIMIT)
  testJira() {
    return this.jira.test();
  }

  @Get('rules')
  listRules() {
    return this.notifications.listRules();
  }

  @Post('rules')
  createRule(@Body(new ZodPipe(notificationRuleSchema)) body: z.infer<typeof notificationRuleSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.notifications.createRule(body, me.user, requestContext(req));
  }

  @Put('rules/:id')
  updateRule(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(notificationRuleSchema)) body: z.infer<typeof notificationRuleSchema>, @CurrentUser() me: RequestUser, @Req() req: Request) {
    return this.notifications.updateRule(id, body, me.user, requestContext(req));
  }

  @Delete('rules/:id')
  @HttpCode(200)
  async deleteRule(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request) {
    await this.notifications.deleteRule(id, me.user, requestContext(req));
    return { ok: true };
  }
}

@Controller('settings/ticketing')
export class TicketingSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('tickets:read')
  get(): Promise<TicketingSettings> {
    return this.settings.getTicketing();
  }

  @Put()
  @RequirePermissions('settings:manage')
  async update(@Body(new ZodPipe(ticketingSettingsSchema)) body: TicketingSettings, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<TicketingSettings> {
    const before = await this.settings.getTicketing();
    const after = await this.settings.updateTicketing(body, me.user.id);
    await this.audit.record({ action: 'settings.ticketing_updated', actor: me.user, details: { before, after }, ip: requestContext(req).ip });
    return after;
  }
}
