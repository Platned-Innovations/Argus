import {
  type AdvisoryDto,
  type IntelItemDto,
  type IntelItemStatus,
  INTEL_ITEM_STATUS_LABELS,
  INTEL_ITEM_STATUSES,
  type IntelOverviewDto,
  type IntelSettings,
  type IntelSourceDto,
  type Paged,
} from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Plus, RefreshCw, Rss, Sparkles, Trash2, XCircle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AiLabel } from '../components/ai';
import { SeverityBadge } from '../components/findings';
import { AdvisoryFields, type AdvisoryForm, emptyAdvisory, fromAdvisoryForm, toAdvisoryForm } from '../components/intel';
import { Badge, Button, Card, CardHeader, CenteredSpinner, Checkbox, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Pagination, Select, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatRelative } from '../lib/utils';
import { IntelStatusCard } from './admin/ScanningSettingsPage';

type Tab = 'overview' | 'review' | 'advisories' | 'sources';

const STATUS_TONE: Record<IntelItemStatus, 'slate' | 'amber' | 'green' | 'red' | 'indigo'> = { new: 'slate', no_match: 'slate', review: 'amber', approved: 'green', rejected: 'slate', error: 'red' };

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </Card>
  );
}

function Overview({ onReview }: { onReview(): void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const o = useQuery({ queryKey: ['intel', 'overview'], queryFn: () => api<IntelOverviewDto>('/intel/overview'), refetchInterval: 15_000 });
  const rematch = useMutation({
    mutationFn: () => api('/intel/rematch', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Re-check queued. New findings appear within a few minutes.');
      void qc.invalidateQueries({ queryKey: ['intel', 'overview'] });
    },
  });
  if (o.isLoading) return <CenteredSpinner />;
  if (!o.data) return <ErrorAlert error={o.error} />;
  const d = o.data;
  const r = d.lastRematch;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <button className="text-left" onClick={onReview}>
          <Stat label="Awaiting review" value={d.items.review} hint={d.aiExtraction ? 'AI-extracted advisories' : 'AI extraction is off'} />
        </button>
        <Stat label="Argus advisories" value={d.advisories.active} hint="Active, matched in every scan" />
        <Stat label="News sources" value={`${d.sources.enabled} / ${d.sources.total}`} hint={d.sources.failing ? `${d.sources.failing} failing` : 'enabled / total'} />
        <Stat label="Last re-check" value={r ? formatRelative(r.at) : 'Never'} hint={r ? (r.error ? `Failed: ${r.error}` : `${r.newFindings} new finding(s) in ${r.repos} repositories`) : 'Runs on a schedule'} />
      </div>

      <Card>
        <CardHeader
          title="Emerging threats"
          description="Advisories published after a repository's last scan that matched its current dependencies. Findings and tickets were opened without waiting for the next scan."
          actions={
            can('intel:manage') && (
              <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={rematch.isPending} onClick={() => rematch.mutate()}>
                Re-check now
              </Button>
            )
          }
        />
        <ErrorAlert error={rematch.error} />
        {d.emerging.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">Nothing new since the last scans.</p>
        ) : (
          <Table head={['Advisory', 'Package', 'Severity', 'Repositories', 'Findings', 'When']}>
            {d.emerging.map((t) => (
              <tr key={`${t.advisoryId}-${t.packageName}-${t.at}`}>
                <td className="px-4 py-2">
                  <div className="font-medium">{t.title}</div>
                  <div className="font-mono text-xs text-slate-500">{t.advisoryId}</div>
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {t.packageName} <span className="text-slate-400">({t.ecosystem})</span>
                </td>
                <td className="px-4 py-2">
                  <SeverityBadge severity={t.severity} />
                </td>
                <td className="px-4 py-2">{t.repos}</td>
                <td className="px-4 py-2">{t.findings}</td>
                <td className="px-4 py-2 text-xs text-slate-500" title={formatDateTime(t.at)}>
                  {formatRelative(t.at)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {can('settings:read') && <IntelStatusCard />}
    </div>
  );
}

function ItemCard({ item }: { item: IntelItemDto }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can('intel:manage');
  const [forms, setForms] = useState<AdvisoryForm[]>(() => item.candidates.map(toAdvisoryForm));
  useEffect(() => setForms(item.candidates.map(toAdvisoryForm)), [item]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['intel'] });
  };
  const review = useMutation({
    mutationFn: (action: 'approve' | 'reject') => api(`/intel/items/${item.id}/review`, { method: 'POST', body: action === 'approve' ? { action, advisories: forms.map(fromAdvisoryForm) } : { action } }),
    onSuccess: (_d, action) => {
      toast.success(action === 'approve' ? 'Approved. Repositories are being checked now.' : 'Rejected.');
      refresh();
    },
  });
  const analyse = useMutation({ mutationFn: () => api(`/intel/items/${item.id}/reanalyse`, { method: 'POST' }), onSuccess: refresh });
  const editable = manage && ['review', 'new', 'no_match', 'rejected', 'error'].includes(item.status);

  return (
    <Card>
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[item.status]}>{INTEL_ITEM_STATUS_LABELS[item.status]}</Badge>
              <span className="text-xs text-slate-500">
                {item.sourceName} · {formatRelative(item.publishedAt ?? item.fetchedAt)}
              </span>
            </div>
            <h3 className="mt-1 font-semibold">
              {item.link ? (
                <a href={item.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  {item.title} <ExternalLink className="size-3.5" />
                </a>
              ) : (
                item.title
              )}
            </h3>
          </div>
          {manage && ['new', 'error', 'no_match'].includes(item.status) && (
            <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" />} loading={analyse.isPending} onClick={() => analyse.mutate()}>
              Analyse with AI
            </Button>
          )}
        </div>
        <ErrorAlert error={review.error ?? analyse.error} />
        <p className="line-clamp-4 text-sm whitespace-pre-line text-slate-600 dark:text-slate-400">{item.summary}</p>
        {item.error && <p className="text-sm text-red-600">Analysis failed: {item.error}</p>}
        {item.extraction && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <AiLabel provider={item.extraction.provider} model={item.extraction.model} at={item.extraction.at} />
            <span>{Math.round(item.extraction.confidence * 100)}% confidence</span>
            <span className="italic">{item.extraction.rationale}</span>
          </div>
        )}
        {item.reviewedAt && (
          <p className="text-xs text-slate-500">
            {item.status === 'approved' ? 'Approved' : 'Reviewed'} {item.reviewedByName ? `by ${item.reviewedByName}` : 'automatically (above the confidence threshold)'} {formatRelative(item.reviewedAt)}.
          </p>
        )}

        {forms.length > 0 && item.status !== 'approved' && (
          <div className="space-y-4 border-t border-slate-100 pt-4 dark:border-slate-800">
            <p className="text-sm font-medium">Proposed advisories {editable && <span className="font-normal text-slate-500">— check and edit before approving</span>}</p>
            {forms.map((f, i) => (
              <fieldset key={i} disabled={!editable} className="rounded-md p-3 ring-1 ring-slate-200 dark:ring-slate-800">
                <AdvisoryFields idPrefix={`${item.id}-${i}`} value={f} onChange={(v) => setForms(forms.map((x, j) => (j === i ? v : x)))} />
                {editable && forms.length > 1 && (
                  <Button size="sm" variant="ghost" className="mt-2" icon={<Trash2 className="size-4" />} onClick={() => setForms(forms.filter((_x, j) => j !== i))}>
                    Remove
                  </Button>
                )}
              </fieldset>
            ))}
          </div>
        )}
        {editable && (
          <div className="flex flex-wrap gap-2">
            {forms.length === 0 && (
              <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setForms([{ ...emptyAdvisory, title: item.title.slice(0, 300), references: item.link ?? '' }])}>
                Create advisory from this item
              </Button>
            )}
            {forms.length > 0 && (
              <Button size="sm" icon={<CheckCircle2 className="size-4" />} loading={review.isPending && review.variables === 'approve'} onClick={() => review.mutate('approve')}>
                Approve {forms.length > 1 ? `${forms.length} advisories` : 'advisory'}
              </Button>
            )}
            {item.status !== 'rejected' && (
              <Button size="sm" variant="secondary" icon={<XCircle className="size-4" />} loading={review.isPending && review.variables === 'reject'} onClick={() => review.mutate('reject')}>
                Reject
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function ReviewQueue() {
  const [status, setStatus] = useState<IntelItemStatus | ''>('review');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const items = useQuery({ queryKey: ['intel', 'items', status, search, page], queryFn: () => api<Paged<IntelItemDto>>('/intel/items', { query: { status: status || undefined, search: search || undefined, page, pageSize: 10 } }) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Select
          aria-label="Status"
          className="w-56"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as IntelItemStatus | '');
            setPage(1);
          }}
        >
          <option value="">All items</option>
          {INTEL_ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {INTEL_ITEM_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Search"
          placeholder="Search titles"
          className="w-64"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <ErrorAlert error={items.error} />
      {items.isLoading && <CenteredSpinner />}
      {items.data && items.data.items.length === 0 && <EmptyState icon={<Rss className="size-5" />} title="Nothing here" description={status === 'review' ? 'No AI-extracted advisories are waiting for review.' : 'No news items match.'} />}
      {items.data?.items.map((i) => <ItemCard key={i.id} item={i} />)}
      {items.data && <Pagination page={page} pageSize={10} total={items.data.total} onPage={setPage} />}
    </div>
  );
}

function AdvisoryModal({ onClose }: { onClose(): void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<AdvisoryForm>(emptyAdvisory);
  const save = useMutation({
    mutationFn: () => api<AdvisoryDto>('/intel/advisories', { method: 'POST', body: fromAdvisoryForm(form) }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['intel'] });
      toast.success(`${a.key} created. ${a.affectedRepos} repository(ies) match today; findings are being opened.`);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="New advisory"
      description="For vulnerabilities not (yet) in public databases, e.g. from a vendor bulletin or your own research. It is matched against every repository immediately and in every scan."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="advisory-form" loading={save.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form id="advisory-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={save.error} />
        <AdvisoryFields idPrefix="new" value={form} onChange={setForm} />
      </form>
    </Modal>
  );
}

function Advisories() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['intel', 'advisories', search, page], queryFn: () => api<Paged<AdvisoryDto>>('/intel/advisories', { query: { search: search || undefined, page, pageSize: 25 } }) });
  const toggle = useMutation({
    mutationFn: (a: AdvisoryDto) => api(`/intel/advisories/${a.id}`, { method: 'PATCH', body: { withdrawn: !a.withdrawn } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['intel'] }),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3">
        <Input
          aria-label="Search"
          placeholder="Search key, package, title or CVE"
          className="w-72"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        {can('intel:manage') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New advisory
          </Button>
        )}
      </div>
      <ErrorAlert error={list.error ?? toggle.error} />
      <Card>
        {list.data && list.data.items.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">No Argus advisories yet. They come from approved news items or are entered by hand; public advisories (OSV, GitHub) are used directly.</p>
        ) : (
          <Table head={['Advisory', 'Package', 'Affected', 'Severity', 'Repositories', 'Source', '']}>
            {list.data?.items.map((a) => (
              <tr key={a.id} className={a.withdrawn ? 'opacity-60' : ''}>
                <td className="px-4 py-2">
                  <div className="font-medium">{a.title}</div>
                  <div className="font-mono text-xs text-slate-500">
                    {a.key}
                    {a.cveIds.length ? ` · ${a.cveIds.join(', ')}` : ''}
                  </div>
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {a.packageName} <span className="text-slate-400">({a.ecosystem})</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">
                  {a.affectedRange}
                  {a.fixedVersion && <div className="text-slate-500">fixed {a.fixedVersion}</div>}
                </td>
                <td className="px-4 py-2">
                  <SeverityBadge severity={a.severity} />
                </td>
                <td className="px-4 py-2">{a.withdrawn ? '—' : a.affectedRepos}</td>
                <td className="px-4 py-2 text-xs">
                  {a.source === 'news' ? (a.autoApproved ? 'News (auto-approved)' : 'News') : 'Manual'}
                  {a.createdByName && <div className="text-slate-500">{a.createdByName}</div>}
                </td>
                <td className="px-4 py-2 text-right">
                  {can('intel:manage') && (
                    <Button size="sm" variant="ghost" loading={toggle.isPending && toggle.variables?.id === a.id} onClick={() => toggle.mutate(a)}>
                      {a.withdrawn ? 'Restore' : 'Withdraw'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {list.data && <Pagination page={page} pageSize={25} total={list.data.total} onPage={setPage} />}
      {creating && <AdvisoryModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function SourceModal({ source, onClose }: { source: IntelSourceDto | null; onClose(): void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: source?.name ?? '', url: source?.url ?? '', enabled: source?.enabled ?? true, intervalMinutes: source?.intervalMinutes ?? 360 });
  const save = useMutation({
    mutationFn: () => (source ? api(`/intel/sources/${source.id}`, { method: 'PUT', body: f }) : api('/intel/sources', { method: 'POST', body: f })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['intel'] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={source ? `Edit ${source.name}` : 'Add news source'}
      description="An RSS or Atom feed of security news or advisories."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="source-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="source-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={save.error} />
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />}</Field>
        <Field label="Feed URL" hint="HTTPS only.">
          {(id) => <Input id={id} type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required placeholder="https://…/feed.xml" />}
        </Field>
        <Field label="Fetch every (minutes)">{(id) => <Input id={id} type="number" min={15} max={10080} value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })} />}</Field>
        <Checkbox label="Enabled" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
      </form>
    </Modal>
  );
}

function IntelSettingsCard() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const current = useQuery({ queryKey: ['intel', 'settings'], queryFn: () => api<IntelSettings>('/intel/settings') });
  const [f, setF] = useState<IntelSettings | null>(null);
  useEffect(() => {
    if (current.data) setF(current.data);
  }, [current.data]);
  const save = useMutation({
    mutationFn: (v: IntelSettings) => api<IntelSettings>('/intel/settings', { method: 'PUT', body: v }),
    onSuccess: (d) => {
      qc.setQueryData(['intel', 'settings'], d);
      toast.success('Threat intelligence settings saved.');
    },
  });
  if (!f) return current.error ? <ErrorAlert error={current.error} /> : null;
  const readOnly = !can('settings:manage');
  return (
    <Card>
      <CardHeader title="Settings" description={readOnly ? 'Only administrators can change these.' : undefined} />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(f);
        }}
      >
        <ErrorAlert error={save.error} />
        <fieldset disabled={readOnly} className="space-y-4">
          <Checkbox label="Fetch news sources" description="Enabled sources are fetched on their schedule. Turn off to pause all fetching." checked={f.crawlEnabled} onChange={(e) => setF({ ...f, crawlEnabled: e.target.checked })} />
          <Checkbox
            label="Approve AI-extracted advisories automatically"
            description="Skips review when the model's confidence is at or above the threshold. Off by default: a wrong advisory opens findings in every matching repository."
            checked={f.autoApprove}
            onChange={(e) => setF({ ...f, autoApprove: e.target.checked })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Auto-approve confidence threshold">
              {(id) => <Input id={id} type="number" min={0.5} max={1} step={0.05} value={f.autoApproveMinConfidence} disabled={!f.autoApprove} onChange={(e) => setF({ ...f, autoApproveMinConfidence: Number(e.target.value) })} />}
            </Field>
            <Field label="Re-check inventories every (hours)" hint="Looks up newly published OSV advisories for every repository's current dependencies.">
              {(id) => <Input id={id} type="number" min={1} max={168} value={f.rematchIntervalHours} onChange={(e) => setF({ ...f, rematchIntervalHours: Number(e.target.value) })} />}
            </Field>
          </div>
        </fieldset>
        {!readOnly && (
          <Button type="submit" loading={save.isPending}>
            Save settings
          </Button>
        )}
      </form>
    </Card>
  );
}

function Sources() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<IntelSourceDto | null | undefined>(undefined);
  const list = useQuery({ queryKey: ['intel', 'sources'], queryFn: () => api<IntelSourceDto[]>('/intel/sources') });
  const fetchNow = useMutation({
    mutationFn: (s: IntelSourceDto) => api<IntelSourceDto>(`/intel/sources/${s.id}/fetch`, { method: 'POST' }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['intel'] });
      if (s.lastError) toast.error(`${s.name}: ${s.lastError}`);
      else toast.success(`${s.name}: ${s.lastNewItems ?? 0} new item(s).`);
    },
  });
  const remove = useMutation({ mutationFn: (s: IntelSourceDto) => api(`/intel/sources/${s.id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['intel'] }) });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="News sources"
          description="Security news and advisory feeds. New items are analysed by AI (if enabled under Administration → AI assistance) and proposed for review."
          actions={
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>
              Add source
            </Button>
          }
        />
        <ErrorAlert error={list.error ?? fetchNow.error ?? remove.error} />
        <Table head={['Source', 'Every', 'Last fetched', 'Status', '']}>
          {list.data?.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-2">
                <div className="font-medium">{s.name}</div>
                <div className="max-w-md truncate text-xs text-slate-500">{s.url}</div>
              </td>
              <td className="px-4 py-2 text-sm">{s.intervalMinutes >= 60 ? `${Math.round(s.intervalMinutes / 60)} h` : `${s.intervalMinutes} min`}</td>
              <td className="px-4 py-2 text-sm">{s.lastFetchedAt ? formatRelative(s.lastFetchedAt) : 'Never'}</td>
              <td className="px-4 py-2 text-sm">
                {!s.enabled ? <Badge>Off</Badge> : s.lastError ? <span className="text-red-600" title={s.lastError}>{s.lastError.slice(0, 60)}</span> : <Badge tone="green">{s.lastNewItems === null ? 'Enabled' : `${s.lastNewItems} new`}</Badge>}
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap">
                <Button size="sm" variant="ghost" loading={fetchNow.isPending && fetchNow.variables?.id === s.id} onClick={() => fetchNow.mutate(s)}>
                  Fetch now
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} icon={<Trash2 className="size-4" />} onClick={() => confirm(`Delete ${s.name} and its items?`) && remove.mutate(s)} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <IntelSettingsCard />
      {editing !== undefined && <SourceModal source={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

export function ThreatIntelPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['review', 'News & review'],
    ['advisories', 'Argus advisories'],
    ...(can('intel:manage') ? ([['sources', 'Sources & settings']] as [Tab, string][]) : []),
  ];
  return (
    <>
      <PageHeader title="Threat intelligence" description="New advisories from security news and public databases, matched continuously against every repository's dependencies." />
      <div className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview onReview={() => setTab('review')} />}
      {tab === 'review' && <ReviewQueue />}
      {tab === 'advisories' && <Advisories />}
      {tab === 'sources' && <Sources />}
    </>
  );
}
