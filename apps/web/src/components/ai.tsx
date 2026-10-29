import {
  AI_PROVIDER_LABELS,
  AI_VERDICT_LABELS,
  type AiDraftDto,
  type AiInsightDto,
  type AiProvider,
  type AiStatusDto,
  type FindingAiHintDto,
  type RemediationOutput,
} from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatRelative } from '../lib/utils';
import { Badge, Button, Card, CardHeader, ErrorAlert } from './ui';

export function useAiStatus() {
  return useQuery({ queryKey: ['ai', 'status'], queryFn: () => api<AiStatusDto>('/ai/status'), staleTime: 60_000 });
}

/** Provenance label shown on every AI output. */
export function AiLabel({ provider, model, at }: { provider: AiProvider; model: string; at?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-600/20 ring-inset dark:bg-violet-500/10 dark:text-violet-300" title={`${AI_PROVIDER_LABELS[provider]} · ${model}${at ? ` · ${formatDateTime(at)}` : ''}`}>
      <Sparkles className="size-3" /> AI-assisted · {model}
    </span>
  );
}

const VERDICT_TONE: Record<string, 'green' | 'red' | 'amber' | 'slate'> = {
  likely_false_positive: 'green',
  likely_not_affected: 'green',
  likely_real: 'red',
  likely_affected: 'red',
  uncertain: 'amber',
};

export function AiHintBadge({ hint }: { hint: FindingAiHintDto }) {
  return (
    <span title={`AI-assisted (${hint.model}), ${Math.round(hint.confidence * 100)}% confidence: ${hint.rationale}`}>
      <Badge tone={VERDICT_TONE[hint.verdict] ?? 'slate'}>
        <Sparkles className="mr-1 size-3" />
        {AI_VERDICT_LABELS[hint.verdict] ?? hint.verdict}
      </Badge>
    </span>
  );
}

/** Full AI hint for a finding detail view. */
export function AiHintPanel({ hint }: { hint: FindingAiHintDto }) {
  return (
    <div className="rounded-md bg-violet-50/60 p-3 text-sm ring-1 ring-violet-600/15 dark:bg-violet-500/5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <AiHintBadge hint={hint} />
        <span className="text-xs text-slate-500">{Math.round(hint.confidence * 100)}% confidence</span>
        <AiLabel provider={hint.provider} model={hint.model} at={hint.createdAt} />
      </div>
      <p className="text-slate-700 dark:text-slate-300">{hint.rationale}</p>
      <p className="mt-1 text-xs text-slate-500">A hint for prioritisation only. It does not change the finding; confirm before acting.</p>
    </div>
  );
}

const RISK_TONE = { low: 'green', medium: 'amber', high: 'red', unknown: 'slate' } as const;

export function RemediationPanel({ ticketId }: { ticketId: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const status = useAiStatus();
  const current = useQuery({ queryKey: ['ticket', ticketId, 'ai-remediation'], queryFn: () => api<AiInsightDto<RemediationOutput> | null>(`/tickets/${ticketId}/ai/remediation`) });
  const generate = useMutation({
    mutationFn: () => api<AiInsightDto<RemediationOutput>>(`/tickets/${ticketId}/ai/remediation`, { method: 'POST' }),
    onSuccess: (d) => {
      qc.setQueryData(['ticket', ticketId, 'ai-remediation'], d);
      void qc.invalidateQueries({ queryKey: ['ticket', ticketId], exact: true });
      void qc.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
  });
  const comment = useMutation({
    mutationFn: () => api(`/tickets/${ticketId}/ai/remediation/comment`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticket', ticketId], exact: true });
      toast.success('Suggestion added as a comment.');
    },
  });

  const available = !!status.data?.useCases.remediation && can('ai:use');
  const s = current.data;
  if (!s && !available) return null;
  const o = s?.output;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles className="size-4 text-violet-600" /> AI remediation suggestion
          </span>
        }
        description={s ? `Generated ${formatRelative(s.createdAt)}${s.createdByName ? ` by ${s.createdByName}` : ''}. Review before acting.` : 'Step-by-step fix guidance based on this ticket’s findings and advisories.'}
        actions={
          available && (
            <Button size="sm" variant={s ? 'secondary' : 'primary'} icon={s ? <RefreshCw className="size-4" /> : <Sparkles className="size-4" />} loading={generate.isPending} onClick={() => generate.mutate()}>
              {s ? 'Regenerate' : 'Suggest a fix'}
            </Button>
          )
        }
      />
      <div className="space-y-3 p-5 text-sm">
        <ErrorAlert error={generate.error ?? comment.error ?? current.error} />
        {status.data?.budgetExhausted && <p className="text-amber-700 dark:text-amber-400">The monthly AI budget has been reached.</p>}
        {s && o && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <AiLabel provider={s.provider} model={s.model} at={s.createdAt} />
              <Badge tone={RISK_TONE[o.breakingChangeRisk]}>Breaking-change risk: {o.breakingChangeRisk}</Badge>
              {o.fixVersion && <Badge tone="indigo">Fixed in {o.fixVersion}</Badge>}
              <span className="text-xs text-slate-500">{Math.round(o.confidence * 100)}% confidence</span>
              {s.redactions > 0 && <span className="text-xs text-slate-500">{s.redactions} secret-like value(s) redacted before sending</span>}
            </div>
            <p className="font-medium">{o.summary}</p>
            <ol className="list-decimal space-y-1 pl-5">
              {o.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <p className="text-slate-600 dark:text-slate-400">
              <span className="font-medium">Why: </span>
              {o.rationale}
            </p>
            {can('tickets:write') && can('ai:use') && (
              <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="size-4" />} loading={comment.isPending} onClick={() => comment.mutate()}>
                Add as comment
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** "Draft with AI" for the Jira and email forms; the result is only filled in, never sent. */
export function DraftWithAiButton({ ticketId, target, onDraft }: { ticketId: string; target: 'jira' | 'email'; onDraft(d: AiDraftDto): void }) {
  const { can } = useAuth();
  const status = useAiStatus();
  const draft = useMutation({
    mutationFn: () => api<AiDraftDto>(`/tickets/${ticketId}/ai/draft`, { method: 'POST', body: { target } }),
    onSuccess: (d) => {
      onDraft(d);
      toast.success('Draft filled in. Review and edit before sending.');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Drafting failed.'),
  });
  if (!status.data?.useCases.ticket_draft || !can('ai:use')) return null;
  return (
    <Button type="button" size="sm" variant="secondary" icon={<Sparkles className="size-4" />} loading={draft.isPending} onClick={() => draft.mutate()}>
      Draft with AI
    </Button>
  );
}
