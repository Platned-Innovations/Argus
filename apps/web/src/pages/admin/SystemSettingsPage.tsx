import { type BrandingSettings, type SettingsExport, type SettingsImportResultDto } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardHeader, CenteredSpinner, ErrorAlert, Field, Input, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';

export function SystemSettingsPage() {
  return (
    <>
      <PageHeader title="System" description="How this installation presents itself, and its configuration as a file." />
      <div className="space-y-6">
        <BrandingCard />
        <ConfigurationCard />
      </div>
    </>
  );
}

function BrandingCard() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['branding'], queryFn: () => api<BrandingSettings>('/settings/branding') });
  const [form, setForm] = useState<BrandingSettings | null>(null);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);
  const save = useMutation({
    mutationFn: (body: BrandingSettings) => api<BrandingSettings>('/settings/branding', { method: 'PUT', body }),
    onSuccess: (data) => {
      qc.setQueryData(['branding'], data);
      toast.success('Branding saved.');
    },
  });
  if (!form) return <CenteredSpinner />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };
  return (
    <Card>
      <CardHeader title="Branding" description="Shown in the app, on the sign-in page, in email subjects and footers, and in authenticator apps for newly set-up MFA." />
      <form onSubmit={submit} className="space-y-4 p-5">
        <ErrorAlert error={query.error ?? save.error} />
        <Field label="Product name" hint="Up to 40 characters, e.g. “Contoso Security”.">
          {(id) => <Input id={id} value={form.productName} maxLength={40} onChange={(e) => setForm({ ...form, productName: e.target.value })} required />}
        </Field>
        <Field label="Sign-in notice" hint="Optional plain text below the sign-in form, such as an acceptable-use statement.">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              maxLength={1000}
              value={form.loginNotice}
              onChange={(e) => setForm({ ...form, loginNotice: e.target.value })}
              className="block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-indigo-600 focus:ring-inset dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700"
            />
          )}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save branding
          </Button>
        </div>
      </form>
    </Card>
  );
}

const SECTION_LABELS: Record<string, string> = {
  security: 'security',
  scanning: 'scanning',
  ticketing: 'ticketing and SLA',
  retention: 'retention',
  intel: 'threat intelligence',
  branding: 'branding',
};

function ConfigurationCard() {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<unknown>(null);
  const exportFile = useMutation({
    mutationFn: () => api<SettingsExport>('/settings/export'),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `argus-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const importFile = useMutation({
    mutationFn: (body: unknown) => api<SettingsImportResultDto>('/settings/import', { method: 'POST', body }),
    onSuccess: (r) => {
      const parts = [r.applied.length ? `Replaced ${r.applied.map((s) => SECTION_LABELS[s] ?? s).join(', ')} settings` : 'No settings sections in the file'];
      if (r.intelSourcesAdded || r.intelSourcesSkipped) parts.push(`added ${r.intelSourcesAdded} news source(s), skipped ${r.intelSourcesSkipped} already configured`);
      toast.success(`${parts.join('; ')}.`);
      void qc.invalidateQueries();
    },
  });

  const onFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      setError(new Error('The file is not valid JSON.'));
      return;
    }
    if (!window.confirm('Importing replaces every settings section in the file with its values. Continue?')) return;
    importFile.mutate(body);
  };

  return (
    <Card>
      <CardHeader
        title="Configuration file"
        description="Copy settings between installations, or keep them under version control. The file never contains secrets (credentials, API keys, email and webhook secrets) or installation data (sources, repositories, users, teams, notification rules)."
      />
      <div className="space-y-4 p-5">
        <ErrorAlert error={error ?? exportFile.error ?? importFile.error} />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Includes security, scanning, ticketing and SLA, retention, threat-intelligence and branding settings, plus the news sources. On import, each section in the file replaces the current one; news sources that are already configured (same URL)
          are skipped. Imports are recorded in the audit log.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download className="size-4" />} loading={exportFile.isPending} onClick={() => exportFile.mutate()}>
            Export settings
          </Button>
          <Button variant="secondary" icon={<Upload className="size-4" />} loading={importFile.isPending} onClick={() => fileInput.current?.click()}>
            Import settings…
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </Card>
  );
}
