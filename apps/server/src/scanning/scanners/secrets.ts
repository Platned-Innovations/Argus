import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isTestPath } from '../risk';
import { type DraftFinding, type ScanInput, type Scanner, type ScannerOutput } from '../types';

const execFileAsync = promisify(execFile);

interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** Capture group holding the secret (0 = whole match). */
  group?: number;
  base: number;
  /** Extra check to cut false positives (e.g. entropy of generic assignments). */
  accept?: (value: string) => boolean;
}

export const PLACEHOLDER = /^(x+|\*+|changeme|change_me|password|secret|example|sample|dummy|test|todo|redacted|null|none|undefined|<[^>]*>|\$\{.*\}|\{\{.*\}\}|%[A-Z_]+%)$/i;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Built-in detectors, used when Gitleaks is not installed. Deliberately high-signal. */
export const BUILTIN_RULES: SecretRule[] = [
  { id: 'private-key', description: 'Private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, base: 90 },
  { id: 'aws-access-token', description: 'AWS access key ID', pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g, group: 1, base: 85 },
  { id: 'github-pat', description: 'GitHub personal access token', pattern: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g, group: 1, base: 80 },
  { id: 'github-app-token', description: 'GitHub OAuth / app token', pattern: /\b((?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{36})\b/g, group: 1, base: 80 },
  { id: 'gitlab-pat', description: 'GitLab personal access token', pattern: /\b(glpat-[A-Za-z0-9_-]{20})\b/g, group: 1, base: 80 },
  { id: 'slack-token', description: 'Slack token', pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, group: 1, base: 75 },
  { id: 'slack-webhook-url', description: 'Slack incoming webhook', pattern: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,})/g, group: 1, base: 60 },
  { id: 'stripe-secret-key', description: 'Stripe live secret key', pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{24,})\b/g, group: 1, base: 85 },
  { id: 'gcp-api-key', description: 'Google API key', pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1, base: 70 },
  { id: 'azure-storage-account-key', description: 'Azure Storage account key', pattern: /AccountKey=([A-Za-z0-9+/]{86}==)/g, group: 1, base: 85 },
  { id: 'npm-access-token', description: 'npm access token', pattern: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1, base: 80 },
  { id: 'sendgrid-api-token', description: 'SendGrid API key', pattern: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, group: 1, base: 75 },
  { id: 'jwt', description: 'JSON Web Token', pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, group: 1, base: 55 },
  {
    id: 'connection-string-password',
    description: 'Password in a connection string',
    pattern: /(?:^|[;"'\s])(?:Password|Pwd)\s*=\s*([^;"'\s]{6,})/gi,
    group: 1,
    base: 65,
    accept: (v) => !PLACEHOLDER.test(v),
  },
  {
    id: 'generic-api-key',
    description: 'Hard-coded secret assignment',
    pattern: /\b(?:api[_-]?key|secret|token|passwd|password|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,200})["']/gi,
    group: 1,
    base: 55,
    accept: (v) => !PLACEHOLDER.test(v) && shannonEntropy(v) >= 3.5,
  },
];

const SECRET_BASE_BY_KEYWORD: [RegExp, number][] = [
  [/private-key/i, 90],
  [/aws|gcp|azure|alibaba|stripe/i, 85],
  [/github|gitlab|npm|pypi|slack|sendgrid|twilio|shopify|atlassian|bitbucket|heroku|okta|databricks|openai|anthropic/i, 80],
  [/jwt/i, 55],
  [/generic/i, 55],
];

function baseForRule(ruleId: string): number {
  return SECRET_BASE_BY_KEYWORD.find(([re]) => re.test(ruleId))?.[1] ?? 70;
}

/** "AKIA…MPLE" for long values, fully hidden for short ones. */
export function maskSecret(value: string, ruleId: string): string {
  if (/private-key/i.test(ruleId)) return 'PEM private key';
  if (value.length < 16) return '••••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

const REMEDIATION =
  'Treat the secret as compromised: revoke or rotate it at the issuing service first, then remove it from the code (and from git history, e.g. with git filter-repo) and load it from a secret store or environment variable instead.';

/** "github-pat" -> "Github pat"; used for Gitleaks rules, whose descriptions are full sentences. */
function ruleLabel(ruleId: string): string {
  const s = ruleId.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function draft(input: ScanInput, ruleId: string, label: string, explanation: string, path: string, line: number | null, value: string, base: number, tool: string): DraftFinding {
  const hash = input.hashSecret(value);
  const testPath = isTestPath(path);
  const finding: DraftFinding = {
    ruleId,
    identity: [path, hash],
    title: `${label} in ${path}`,
    description: `${explanation}${testPath ? ' The file looks like test or example code; confirm the value is not a real credential.' : ''}`,
    path,
    line,
    package: null,
    advisory: null,
    secret: { type: ruleId, preview: maskSecret(value, ruleId), hash },
    details: { detector: tool },
    remediation: REMEDIATION,
    risk: { base, baseLabel: label, testPath },
  };
  // Non-enumerable: available to AI triage in memory, but never copied by spreads or serialised.
  Object.defineProperty(finding, 'secretValue', { value, enumerable: false });
  return finding;
}

interface GitleaksResult {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  Secret: string;
}

let gitleaksProbe: Promise<string | null> | null = null;

/** Gitleaks version, or null if the binary is not available. Probed once per process. */
export function gitleaksVersion(binary: string): Promise<string | null> {
  gitleaksProbe ??= execFileAsync(binary, ['version'], { timeout: 10_000, windowsHide: true })
    .then(({ stdout }) => stdout.trim() || 'unknown')
    .catch(() => null);
  return gitleaksProbe;
}

export class SecretsScanner implements Scanner {
  readonly name = 'secrets' as const;

  constructor(
    private readonly gitleaksBinary: string,
    private readonly timeoutMs: number,
  ) {}

  async run(input: ScanInput): Promise<ScannerOutput> {
    const allowed = new Set(input.files.map((f) => f.path));
    const version = await gitleaksVersion(this.gitleaksBinary);
    if (version) {
      input.log(`Secrets: running Gitleaks ${version}`);
      return { status: 'ok', message: `Gitleaks ${version}`, findings: await this.runGitleaks(input, allowed) };
    }
    input.log('Secrets: Gitleaks is not installed; using Argus built-in rules');
    return { status: 'ok', message: 'Built-in rules (Gitleaks not installed)', findings: await this.runBuiltin(input) };
  }

  private async runGitleaks(input: ScanInput, allowed: Set<string>): Promise<DraftFinding[]> {
    const report = `${input.workdir}.gitleaks.json`;
    try {
      await execFileAsync(
        this.gitleaksBinary,
        ['dir', '.', '--report-format', 'json', '--report-path', report, '--no-banner', '--exit-code', '0', '--max-target-megabytes', '5', '--log-level', 'error'],
        { cwd: input.workdir, timeout: this.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      const results = JSON.parse(await readFile(report, 'utf8')) as GitleaksResult[];
      const out: DraftFinding[] = [];
      for (const r of results ?? []) {
        const path = r.File.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!allowed.has(path) || !r.Secret) continue;
        out.push(draft(input, r.RuleID, ruleLabel(r.RuleID), r.Description || `Matched Gitleaks rule ${r.RuleID}.`, path, r.StartLine || null, r.Secret, baseForRule(r.RuleID), 'gitleaks'));
      }
      return out;
    } finally {
      // The report contains raw secret values: never leave it on disk.
      await rm(report, { force: true });
    }
  }

  private async runBuiltin(input: ScanInput): Promise<DraftFinding[]> {
    const out: DraftFinding[] = [];
    for (const file of input.files) {
      if (file.size > 1024 * 1024) continue;
      const text = await input.readText(file);
      if (!text) continue;
      // Specific rules come first; a value they already reported is not reported again by a generic rule.
      const seen = new Set<string>();
      for (const rule of BUILTIN_RULES) {
        rule.pattern.lastIndex = 0;
        for (const m of text.matchAll(rule.pattern)) {
          const value = m[rule.group ?? 0];
          if (!value || seen.has(value) || (rule.accept && !rule.accept(value))) continue;
          seen.add(value);
          const line = text.slice(0, m.index).split('\n').length;
          out.push(draft(input, rule.id, rule.description, `A value matching "${rule.description}" was found in the repository.`, file.path, line, value, rule.base, 'argus'));
        }
      }
    }
    return out;
  }
}
