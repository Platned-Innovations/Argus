import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Advisory, type DataStore, type User } from '@argus/data';
import { type AdvisoryDto, type AdvisoryInput, type IntelSettings, type Paged } from '@argus/shared';
import { type RequestContext } from '../common/request';
import { AuditService } from '../core/audit.service';
import { DATA_STORE } from '../core/tokens';
import { satisfies } from '../scanning/versions';
import { assertRange } from './news.service';
import { RematchService } from './rematch.service';

/** Argus's own advisories: listing with current impact, manual entry and withdrawal. */
@Injectable()
export class AdvisoriesService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly rematch: RematchService,
    private readonly audit: AuditService,
  ) {}

  /** Repositories whose current inventory has a version in the advisory's range. */
  private async affectedRepos(a: Advisory): Promise<number> {
    if (a.withdrawn) return 0;
    const deps = await this.store.dependencies.search({ name: a.packageName, ecosystem: a.ecosystem, limit: 5000 });
    return new Set(deps.filter((d) => satisfies(d.ecosystem, d.version, a.affectedRange)).map((d) => d.repoId)).size;
  }

  private async toDto(a: Advisory): Promise<AdvisoryDto> {
    const by = a.createdBy ? await this.store.users.findById(a.createdBy) : null;
    return { ...a, createdByName: by?.displayName ?? null, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(), affectedRepos: await this.affectedRepos(a) };
  }

  async list(q: { search?: string; withdrawn?: boolean; page: number; pageSize: number }): Promise<Paged<AdvisoryDto>> {
    const page = await this.store.advisories.list({ search: q.search || undefined, withdrawn: q.withdrawn, offset: (q.page - 1) * q.pageSize, limit: q.pageSize });
    return { items: await Promise.all(page.items.map((a) => this.toDto(a))), total: page.total, page: q.page, pageSize: q.pageSize };
  }

  async create(input: AdvisoryInput, actor: User, ctx: RequestContext): Promise<AdvisoryDto> {
    assertRange(input);
    const a = await this.store.advisories.create({ ...input, source: 'manual', sourceItemId: null, withdrawn: false, autoApproved: false, createdBy: actor.id });
    await this.audit.record({ action: 'intel.advisory_created', actor, target: { type: 'advisory', id: a.id }, details: { key: a.key, package: `${a.ecosystem}:${a.packageName}`, range: a.affectedRange, severity: a.severity }, ip: ctx.ip });
    await this.rematch.enqueue('advisory');
    return this.toDto(a);
  }

  /** A withdrawn advisory stops matching; its findings are marked fixed by the next scan of each repository. */
  async setWithdrawn(id: string, withdrawn: boolean, actor: User, ctx: RequestContext): Promise<AdvisoryDto> {
    const a = await this.store.advisories.update(id, { withdrawn });
    if (!a) throw new NotFoundException('Advisory not found.');
    await this.audit.record({ action: withdrawn ? 'intel.advisory_withdrawn' : 'intel.advisory_restored', actor, target: { type: 'advisory', id }, details: { key: a.key }, ip: ctx.ip });
    if (!withdrawn) await this.rematch.enqueue('advisory');
    return this.toDto(a);
  }

  async updateSettings(value: IntelSettings, actor: User, ctx: RequestContext): Promise<IntelSettings> {
    const before = await this.rematch.intelSettings();
    await this.store.settings.set('intel', value, actor.id);
    await this.audit.record({ action: 'settings.intel_updated', actor, details: { before, after: value }, ip: ctx.ip });
    return this.rematch.intelSettings();
  }
}
