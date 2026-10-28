import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { type DataStore, type Team } from '@argus/data';
import { type TeamDto, teamSchema } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../core/audit.service';
import { DATA_STORE } from '../core/tokens';

const teamPatchSchema = teamSchema.partial();

function toDto(t: Team, memberCount: number): TeamDto {
  return { id: t.id, name: t.name, description: t.description, memberCount, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() };
}

@Controller('teams')
export class TeamsController {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('teams:read')
  async list(): Promise<TeamDto[]> {
    return (await this.store.teams.list()).map((t) => toDto(t, t.memberCount));
  }

  @Post()
  @RequirePermissions('teams:manage')
  async create(@Body(new ZodPipe(teamSchema)) body: z.infer<typeof teamSchema>, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<TeamDto> {
    const team = await this.store.teams.create({ name: body.name, description: body.description ?? null });
    await this.audit.record({ action: 'team.created', actor: me.user, target: { type: 'team', id: team.id }, details: { name: team.name }, ip: requestContext(req).ip });
    return toDto(team, 0);
  }

  @Patch(':id')
  @RequirePermissions('teams:manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(teamPatchSchema)) body: z.infer<typeof teamPatchSchema>,
    @CurrentUser() me: RequestUser,
    @Req() req: Request,
  ): Promise<TeamDto> {
    const team = await this.store.teams.update(id, body);
    if (!team) throw new NotFoundException('Team not found.');
    await this.audit.record({ action: 'team.updated', actor: me.user, target: { type: 'team', id }, details: { name: team.name }, ip: requestContext(req).ip });
    const counted = (await this.store.teams.list()).find((t) => t.id === id);
    return toDto(team, counted?.memberCount ?? 0);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('teams:manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<{ ok: true }> {
    const team = await this.store.teams.findById(id);
    if (!team || !(await this.store.teams.delete(id))) throw new NotFoundException('Team not found.');
    await this.audit.record({ action: 'team.deleted', actor: me.user, target: { type: 'team', id }, details: { name: team.name }, ip: requestContext(req).ip });
    return { ok: true };
  }
}
