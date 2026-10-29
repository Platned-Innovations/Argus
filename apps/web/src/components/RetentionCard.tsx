import { type RetentionSettings } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, CardHeader, ErrorAlert, Field, Input } from './ui';

type Form = Record<keyof RetentionSettings, string>;

const FIELDS: { key: keyof RetentionSettings; label: string; hint: string; optional?: boolean; min: number }[] = [
  { key: 'scanRunsDays', label: 'Scan runs (with logs)', hint: 'Finished scans.', min: 7 },
  { key: 'fixedFindingsDays', label: 'Fixed findings', hint: 'Empty keeps them forever. Trends and time-to-fix use them.', optional: true, min: 30 },
  { key: 'auditDays', label: 'Audit log', hint: 'Empty keeps it forever (default). Check compliance obligations first.', optional: true, min: 90 },
  { key: 'intelItemsDays', label: 'Security news items', hint: 'Analysed, approved or rejected items.', min: 30 },
  { key: 'aiUsageDays', label: 'AI usage records', hint: 'Cost accounting.', min: 90 },
];

/** How long historical data is kept; applied daily. */
export function RetentionCard() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can('settings:manage');
  const current = useQuery({ queryKey: ['settings', 'retention'], queryFn: () => api<RetentionSettings>('/settings/retention') });
  const [f, setF] = useState<Form | null>(null);
  useEffect(() => {
    if (current.data) setF(Object.fromEntries(Object.entries(current.data).map(([k, v]) => [k, v === null ? '' : String(v)])) as Form);
  }, [current.data]);
  const save = useMutation({
    mutationFn: (form: Form) => api<RetentionSettings>('/settings/retention', { method: 'PUT', body: Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])) }),
    onSuccess: (d) => {
      qc.setQueryData(['settings', 'retention'], d);
      toast.success('Retention settings saved.');
    },
  });
  if (!f) return current.error ? <ErrorAlert error={current.error} /> : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(f);
  };
  return (
    <Card>
      <CardHeader title="Data retention" description="How long historical data is kept, in days. Applied daily; deletions are recorded in the audit log." />
      <form onSubmit={submit} className="space-y-4 p-5">
        <ErrorAlert error={save.error} />
        <fieldset disabled={!manage} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map((x) => (
            <Field key={x.key} label={x.label} hint={x.hint}>
              {(id) => <Input id={id} type="number" min={x.min} max={3650} value={f[x.key]} required={!x.optional} placeholder={x.optional ? 'Forever' : undefined} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />}
            </Field>
          ))}
        </fieldset>
        {manage && (
          <Button type="submit" loading={save.isPending}>
            Save retention
          </Button>
        )}
      </form>
    </Card>
  );
}
