import { Controller, Get, Header, Inject, Query, Req, StreamableFile } from '@nestjs/common';
import { type AuditEntry, type DataStore } from '@argus/data';
import { type AuditEntryDto, auditQuerySchema, type Paged } from '@argus/shared';
import { type Request } from 'express';
import { type z } from 'zod';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { type RequestUser, requestContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from '../core/audit.service';
import { DATA_STORE } from '../core/tokens';

const EXPORT_LIMIT = 10_000;
const exportQuerySchema = auditQuerySchema.omit({ page: true, pageSize: true });

function toDto(e: AuditEntry): AuditEntryDto {
  return { ...e, at: e.at.toISOString() };
}

/** Neutralises spreadsheet formula injection (cells starting with = + - @ tab or CR) and quotes the cell. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

@Controller('audit')
@RequirePermissions('audit:read')
export class AuditController {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query(new ZodPipe(auditQuerySchema)) q: z.infer<typeof auditQuerySchema>): Promise<Paged<AuditEntryDto>> {
    const { page, pageSize, ...filter } = q;
    const res = await this.store.audit.list({ ...filter, offset: (page - 1) * pageSize, limit: pageSize });
    return { items: res.items.map(toDto), total: res.total, page, pageSize };
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="argus-audit-log.csv"')
  async export(@Query(new ZodPipe(exportQuerySchema)) q: z.infer<typeof exportQuerySchema>, @CurrentUser() me: RequestUser, @Req() req: Request): Promise<StreamableFile> {
    const res = await this.store.audit.list({ ...q, offset: 0, limit: EXPORT_LIMIT });
    const header = ['at', 'actor', 'action', 'outcome', 'target_type', 'target_id', 'ip', 'details'];
    const rows = res.items.map((e) => [e.at.toISOString(), e.actorName, e.action, e.outcome, e.targetType, e.targetId, e.ip, e.details].map(csvCell).join(','));
    await this.audit.record({ action: 'audit.exported', actor: me.user, details: { rows: res.items.length, filter: q }, ip: requestContext(req).ip });
    return new StreamableFile(Buffer.from([header.join(','), ...rows].join('\r\n'), 'utf8'));
  }
}
