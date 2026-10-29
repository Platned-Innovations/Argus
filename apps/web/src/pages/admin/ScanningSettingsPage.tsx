import { type IntelStatusDto, type RiskWeights, type ScanningSettings } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RetentionCard } from '../../components/RetentionCard';
import { Button, Card, CardHeader, CenteredSpinner, ErrorAlert, Field, Input, PageHeader, Table } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatRelative } from '../../lib/utils';

const WEIGHTS: { key: keyof RiskWeights; label: string; hint: string }[] = [
  { key: 'kev', label: 'Known exploited (CISA KEV)', hint: 'Added when a vulnerability is being exploited in the wild.' },
  { key: 'epssMax', label: 'Exploit probability (EPSS), maximum', hint: 'Scaled by the EPSS probability (0–100%).' },
  { key: 'publicRepo', label: 'Public repository', hint: 'Added for issues in publicly visible repositories.' },
  { key: 'devDependency', label: 'Development-only dependency', hint: 'Negative: not shipped to production.' },
  { key: 'transitiveDependency', label: 'Transitive dependency', hint: 'Negative: not referenced directly.' },
  { key: 'testPath', label: 'Test or example code', hint: 'Negative: e.g. secrets under test/ or fixtures/.' },
  { key: 'criticalityLow', label: 'Low business criticality', hint: 'Applied per repository setting.' },
  { key: 'criticalityHigh', label: 'High business criticality', hint: '' },
  { key: 'criticalityCritical', label: 'Critical business criticality', hint: '' },
];

const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function IntelStatusCard() {
  const query = useQuery({ queryKey: ['intel', 'status'], queryFn: () => api<IntelStatusDto>('/intel/status') });
  return (
    <Card>
      <CardHeader title="Threat intelligence sources" description="Where vulnerability and lifecycle data comes from. Lookups are cached and refreshed automatically." />
      <ErrorAlert error={query.error} />
      {!query.data ? (
        <CenteredSpinner />
      ) : (
        <Table head={['Source', 'Last used', 'Status']}>
          {query.data.feeds.map((f) => (
            <tr key={f.key}>
              <td className="px-4 py-2.5">{f.label}</td>
              <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">{formatRelative(f.fetchedAt)}</td>
              <td className="px-4 py-2.5 text-sm">
                {f.error ? (
                  <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                    <XCircle className="size-4" /> {f.error}
                  </span>
                ) : f.fetchedAt ? (
                  <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="size-4" /> OK{f.entries !== null ? ` · ${f.entries.toLocaleString()} entries` : ''}
                  </span>
                ) : (
                  <span className="text-slate-400">Not used yet</span>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td className="px-4 py-2.5">Gitleaks secret scanner</td>
            <td className="px-4 py-2.5 text-slate-500">—</td>
            <td className="px-4 py-2.5 text-sm">
              {query.data.gitleaks.available ? (
                <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                  <CheckCircle2 className="size-4" /> Installed ({query.data.gitleaks.version})
                </span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Not installed — Argus built-in rules are used</span>
              )}
            </td>
          </tr>
        </Table>
      )}
    </Card>
  );
}

export function ScanningSettingsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('settings:manage');
  const query = useQuery({ queryKey: ['settings', 'scanning'], queryFn: () => api<ScanningSettings>('/settings/scanning') });
  const [form, setForm] = useState<ScanningSettings | null>(null);
  const [deny, setDeny] = useState('');
  const [review, setReview] = useState('');
  useEffect(() => {
    if (!query.data) return;
    setForm(query.data);
    setDeny(query.data.licenseDeny.join(', '));
    setReview(query.data.licenseReview.join(', '));
  }, [query.data]);
  const save = useMutation({
    mutationFn: (body: ScanningSettings) => api<ScanningSettings>('/settings/scanning', { method: 'PUT', body }),
    onSuccess: (data) => {
      qc.setQueryData(['settings', 'scanning'], data);
      toast.success('Scanning settings saved. They apply from the next scan.');
    },
  });
  if (!form) return <CenteredSpinner />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...form, licenseDeny: list(deny), licenseReview: list(review) });
  };

  return (
    <>
      <PageHeader title="Scanning settings" description="How findings are scored and which licenses and lifecycles are acceptable." />
      <form onSubmit={submit} className="space-y-6">
        <ErrorAlert error={query.error ?? save.error} />
        <fieldset disabled={!manage} className="space-y-6">
          <Card>
            <CardHeader title="Risk score adjustments" description="Each finding starts from a base score (e.g. CVSS × 10, or the type of secret) and these points are added or removed. The result is clamped to 0–100." />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              {WEIGHTS.map((w) => (
                <Field key={w.key} label={w.label} hint={w.hint}>
                  {(id) => <Input id={id} type="number" min={-50} max={50} value={form.riskWeights[w.key]} onChange={(e) => setForm({ ...form, riskWeights: { ...form.riskWeights, [w.key]: Number(e.target.value) } })} required />}
                </Field>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="License policy" description="SPDX identifiers, comma-separated. A trailing * matches prefixes (e.g. GPL-3.0* matches GPL-3.0-only and GPL-3.0-or-later)." />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Not allowed">{(id) => <Input id={id} value={deny} onChange={(e) => setDeny(e.target.value)} />}</Field>
              <Field label="Needs review">{(id) => <Input id={id} value={review} onChange={(e) => setReview(e.target.value)} />}</Field>
            </div>
          </Card>
          <Card>
            <CardHeader title="Early warnings" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Framework end-of-life warning (days)" hint="Flag frameworks and runtimes this long before support ends.">
                {(id) => <Input id={id} type="number" min={0} max={730} value={form.eolWarningDays} onChange={(e) => setForm({ ...form, eolWarningDays: Number(e.target.value) })} required />}
              </Field>
              <Field label="Certificate and token expiry warning (days)" hint="Flag credentials this long before they expire.">
                {(id) => <Input id={id} type="number" min={1} max={365} value={form.expiryWarningDays} onChange={(e) => setForm({ ...form, expiryWarningDays: Number(e.target.value) })} required />}
              </Field>
            </div>
          </Card>
        </fieldset>
        {manage && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save settings
            </Button>
          </div>
        )}
      </form>
      <div className="mt-6">
        <RetentionCard />
      </div>
      <div className="mt-6">
        <IntelStatusCard />
      </div>
    </>
  );
}
