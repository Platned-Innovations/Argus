import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type AiInsight, type DataStore, type Finding, type Repository, type Ticket, type User } from '@argus/data';
import { type AiDraftDto, type AiInsightDto, type RemediationOutput, type TicketEventDto } from '@argus/shared';
import { AiService } from '../ai/ai.service';
import { DRAFT_OUTPUT, REMEDIATION_OUTPUT } from '../ai/output-schemas';
import { AppConfig } from '../config/app-config';
import { DATA_STORE } from '../core/tokens';
import { TicketsService } from './tickets.service';

const MAX_FINDINGS = 10;

const REMEDIATION_INSTRUCTIONS = [
  'Write remediation guidance for the security ticket below, for the developers who own the repository.',
  'Prefer the smallest safe change, e.g. upgrading to the first fixed version within the same major version when one exists.',
  'For a leaked secret, revoking or rotating it at the issuing service always comes first, then removing it from the code and history.',
  'Do not invent versions, APIs or commands that the facts do not support; when unsure, say what to check.',
].join('\n');

const DRAFT_INSTRUCTIONS = {
  jira: [
    'Draft a Jira issue for the security ticket below.',
    'subject: a concise summary under 120 characters, without the ticket key.',
    'body: plain text for developers — what is wrong, where, why it matters and how to fix it. Mention the Argus ticket key and link when given.',
  ].join('\n'),
  email: [
    'Draft a short email about the security ticket below, addressed to the owners of the repository.',
    'subject: a concise subject line under 120 characters.',
    'body: plain text, a few short paragraphs — what was found, the risk, what to do and by when (the due date, if given). No greeting placeholders like [Name].',
  ].join('\n'),
};

function line(label: string, value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : `${label}: ${String(value)}`;
}

/** AI assistance on tickets: remediation advice and drafts. It informs people and never changes a ticket's status. */
@Injectable()
export class TicketAiService {
  constructor(
    @Inject(DATA_STORE) private readonly store: DataStore,
    private readonly ai: AiService,
    private readonly tickets: TicketsService,
    private readonly config: AppConfig,
  ) {}

  private async facts(t: Ticket): Promise<{ repo: Repository; text: string; findings: Finding[] }> {
    const repo = (await this.store.repositories.findById(t.repoId))!;
    const findings = (await Promise.all(t.findingIds.map((id) => this.store.findings.findById(id))))
      .filter((f): f is Finding => !!f)
      .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.riskScore - a.riskScore)
      .slice(0, MAX_FINDINGS);
    const url = this.config.publicUrl ? `${this.config.publicUrl}/tickets/${t.id}` : null;
    const ticket = [
      line('Ticket', `${t.key}${url ? ` (${url})` : ''}`),
      line('Title', t.title),
      line('Scanner', t.scanner),
      line('Severity', `${t.severity} (risk score ${t.riskScore}/100)`),
      line('Status', t.status),
      line('Due', t.dueAt?.toISOString().slice(0, 10)),
      line('Repository', `${repo.fullName} (${repo.visibility}, business criticality ${repo.criticality}${repo.language ? `, ${repo.language}` : ''})`),
      line('Description', t.description),
      line('Scanner guidance', t.remediation),
    ].filter(Boolean);
    const blocks = findings.map((f) => {
      const p = f.package;
      const a = f.advisory;
      return [
        '<finding>',
        line('Title', f.title),
        line('Rule', f.ruleId),
        line('Status', f.status),
        line('Location', f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : null),
        p ? line('Package', `${p.ecosystem} ${p.name}@${p.version} (${p.direct ? 'direct' : 'transitive'}, ${p.dev ? 'development' : 'production'} dependency; fixed in ${p.fixedVersion ?? 'unknown'}; latest ${p.latestVersion ?? 'unknown'})`) : null,
        a ? line('Advisory', `${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''}${a.summary ? ` — ${a.summary}` : ''}`) : null,
        a ? line('Exploitability', `CVSS ${a.cvssScore ?? 'n/a'}, EPSS ${a.epss ?? 'n/a'}, ${a.kev ? 'listed in CISA KEV (known exploited)' : 'not in CISA KEV'}`) : null,
        f.secret ? line('Secret type', f.secret.type) : null,
        line('Details', f.description),
        '</finding>',
      ]
        .filter(Boolean)
        .join('\n');
    });
    return { repo, findings, text: `<ticket>\n${ticket.join('\n')}\n</ticket>\n\n${blocks.join('\n\n')}` };
  }

  private async toDto<T>(i: AiInsight): Promise<AiInsightDto<T>> {
    const by = i.createdBy ? await this.store.users.findById(i.createdBy) : null;
    return { ...i, output: i.output as T, createdAt: i.createdAt.toISOString(), createdByName: by?.displayName ?? null };
  }

  async getRemediation(id: string, user: User): Promise<AiInsightDto<RemediationOutput> | null> {
    const t = await this.tickets.require(id, user);
    const i = await this.store.aiInsights.find('ticket', t.id, 'remediation');
    return i ? this.toDto<RemediationOutput>(i) : null;
  }

  async generateRemediation(id: string, user: User): Promise<AiInsightDto<RemediationOutput>> {
    const t = await this.tickets.require(id, user);
    const { repo, text } = await this.facts(t);
    const res = await this.ai.run({ useCase: 'remediation', repo, actor: user, instructions: REMEDIATION_INSTRUCTIONS, prompt: text, output: REMEDIATION_OUTPUT, subject: { type: 'ticket', id: t.id } });
    const insight = await this.store.aiInsights.put({
      subjectType: 'ticket',
      subjectId: t.id,
      repoId: t.repoId,
      useCase: 'remediation',
      provider: res.provider,
      model: res.model,
      output: res.output,
      redactions: res.redactions,
      createdBy: user.id,
    });
    await this.tickets.recordEvent(t.id, 'ai_suggestion', user, null, { provider: res.provider, model: res.model });
    return this.toDto<RemediationOutput>(insight);
  }

  /** Posts the current suggestion as a comment, labelled as AI-assisted. */
  async commentRemediation(id: string, user: User): Promise<TicketEventDto> {
    const current = await this.getRemediation(id, user);
    if (!current) throw new NotFoundException('There is no AI suggestion for this ticket yet.');
    const o = current.output;
    const body = [
      `AI-assisted suggestion (${current.provider} · ${current.model}, confidence ${Math.round(o.confidence * 100)}%) — review before acting.`,
      o.summary,
      o.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      o.fixVersion ? `Fixed in: ${o.fixVersion}. Breaking-change risk: ${o.breakingChangeRisk}.` : `Breaking-change risk: ${o.breakingChangeRisk}.`,
      `Why: ${o.rationale}`,
    ].join('\n\n');
    return this.tickets.comment(id, body, user, { aiAssisted: true, provider: current.provider, model: current.model, insightId: current.id });
  }

  async draft(id: string, target: 'jira' | 'email', user: User): Promise<AiDraftDto> {
    const t = await this.tickets.require(id, user);
    const { repo, text } = await this.facts(t);
    const res = await this.ai.run({ useCase: 'ticket_draft', repo, actor: user, instructions: DRAFT_INSTRUCTIONS[target], prompt: text, output: DRAFT_OUTPUT, subject: { type: 'ticket', id: t.id } });
    return { ...res.output, provider: res.provider, model: res.model, redactions: res.redactions };
  }
}
