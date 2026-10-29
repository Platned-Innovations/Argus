import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type DataStore, type User } from '@argus/data';
import { type DashboardDto, type DashboardQuery, type ExpiringItemDto, hasGlobalScope } from '@argus/shared';
import { csvCell } from '../audit/audit.controller';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { DATA_STORE } from '../core/tokens';
import { buildDashboard } from './dashboard';
import { dashboardPdf } from './pdf';

const DAY = 86_400_000;
const EXPORT_PAGE = 500;
const EXPORT_LIMIT = 50_000;

/** Credentials tracked in the inventory, as dashboard expiry items (filled in once the inventory exists). */
export type CredentialExpirySource = (scope: { visibleTeamIds?: string[]; teamId?: string; now: Date }) => Promise<ExpiringItemDto[]>;

/** Computes the dashboard for a scope. Shared by the API and scheduled reports. */
export async function loadDashboard(
  store: DataStore,
  scope: { visibleTeamIds?: string[]; teamId?: string; repoId?: string },
  days: number,
  now = new Date(),
  credentials?: CredentialExpirySource,
): Promise<DashboardDto> {
  const since = new Date(now.getTime() - days * DAY);
  const [findings, tickets, creds] = await Promise.all([
    store.findings.statsRows({ ...scope, since }),
    store.tickets.statsRows({ ...scope, since }),
    // Credentials are not tied to repositories, so a repository dashboard leaves them out.
    credentials && !scope.repoId ? credentials({ visibleTeamIds: scope.visibleTeamIds, teamId: scope.teamId, now }) : Promise.resolve([]),
  ]);
  const repos = await store.repositories.findByIds([...new Set(findings.map((f) => f.repoId))]);
  return buildDashboard(findings, tickets, new Map(repos.map((r) => [r.id, r.fullName])), { days, now, teamId: scope.teamId ?? null, repoId: scope.repoId ?? null, credentials: creds });
}

@Injectable()
export class ReportsService {
  /** Set by the credential inventory module, so dashboards include tracked credentials. */
  credentialSource: CredentialExpirySource | undefined;

  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** Restricts a requested scope to what the user may see. */
  private async scope(q: Pick<DashboardQuery, 'teamId' | 'repoId'>, user: User) {
    const visibleTeamIds = hasGlobalScope(user.role) ? undefined : user.teamIds;
    if (q.teamId && visibleTeamIds && !visibleTeamIds.includes(q.teamId)) throw new ForbiddenException('You cannot see that team.');
    if (q.repoId) {
      const repo = await this.store.repositories.findById(q.repoId);
      if (!repo || (visibleTeamIds && (repo.teamId === null || !visibleTeamIds.includes(repo.teamId)))) throw new NotFoundException('Repository not found.');
    }
    return { visibleTeamIds, teamId: q.teamId, repoId: q.repoId };
  }

  async dashboard(q: DashboardQuery, user: User): Promise<DashboardDto> {
    return loadDashboard(this.store, await this.scope(q, user), q.days, new Date(), this.credentialSource);
  }

  /** The posture report as a PDF, for people who need a file rather than the printable page. */
  async summaryPdf(q: DashboardQuery, user: User, ctx: RequestContext): Promise<Buffer> {
    const d = await this.dashboard(q, user);
    const team = q.teamId ? await this.store.teams.findById(q.teamId) : null;
    const repo = q.repoId ? await this.store.repositories.findById(q.repoId) : null;
    const scope = repo ? `Repository ${repo.fullName}` : team ? `Team ${team.name}` : hasGlobalScope(user.role) ? 'Whole organisation' : 'Your teams';
    const { productName } = await this.settings.getBranding();
    await this.audit.record({ action: 'report.pdf_exported', actor: { id: user.id, username: user.username }, details: { days: q.days, teamId: q.teamId ?? null, repoId: q.repoId ?? null }, ip: ctx.ip });
    return dashboardPdf(d, { product: productName, scope, periodLabel: `Last ${q.days} days` });
  }

  /** Open and suppressed findings in scope, as CSV (spreadsheet-safe cells). */
  async findingsCsv(q: Pick<DashboardQuery, 'teamId' | 'repoId'>, user: User, ctx: RequestContext): Promise<string> {
    const scope = await this.scope(q, user);
    const header = ['repository', 'severity', 'risk_score', 'status', 'scanner', 'rule', 'title', 'location', 'package', 'version', 'fixed_version', 'advisory', 'cves', 'kev', 'epss', 'first_seen', 'last_seen', 'ticket'];
    const rows: string[] = [];
    const names = new Map<string, string>();
    const tickets = new Map<string, string>();
    for (let offset = 0; offset < EXPORT_LIMIT; offset += EXPORT_PAGE) {
      const page = await this.store.findings.list({ visibleTeamIds: scope.visibleTeamIds, repoId: scope.repoId, offset, limit: EXPORT_PAGE });
      const items = scope.teamId ? page.items.filter((f) => f.teamId === scope.teamId) : page.items;
      for (const r of await this.store.repositories.findByIds([...new Set(items.map((f) => f.repoId))].filter((id) => !names.has(id)))) names.set(r.id, r.fullName);
      for (const id of [...new Set(items.map((f) => f.ticketId).filter((x): x is string => !!x && !tickets.has(x)))]) tickets.set(id, (await this.store.tickets.findById(id))?.key ?? '');
      for (const f of items) {
        if (f.status === 'fixed') continue;
        rows.push(
          [
            names.get(f.repoId) ?? f.repoId,
            f.severity,
            f.riskScore,
            f.status,
            f.scanner,
            f.ruleId,
            f.title,
            f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '',
            f.package?.name ?? '',
            f.package?.version ?? '',
            f.package?.fixedVersion ?? '',
            f.advisory?.id ?? '',
            (f.advisory?.aliases ?? []).filter((a) => a.startsWith('CVE-')).join(' '),
            f.advisory?.kev ? 'yes' : '',
            f.advisory?.epss ?? '',
            f.firstSeenAt.toISOString(),
            f.lastSeenAt.toISOString(),
            f.ticketId ? (tickets.get(f.ticketId) ?? '') : '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
      if (page.items.length < EXPORT_PAGE) break;
    }
    await this.audit.record({ action: 'report.findings_exported', actor: { id: user.id, username: user.username }, details: { rows: rows.length, teamId: q.teamId ?? null, repoId: q.repoId ?? null }, ip: ctx.ip });
    return [header.join(','), ...rows].join('\r\n');
  }
}
