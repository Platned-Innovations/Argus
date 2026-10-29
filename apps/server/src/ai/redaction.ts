import { Redactor } from '../common/redact';
import { BUILTIN_RULES, PLACEHOLDER, shannonEntropy } from '../scanning/scanners/secrets';

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** key = value / "key": "value" assignments of anything that sounds like a credential. */
const ASSIGNMENT = /\b([\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|access[_-]?key|auth)[\w.-]*)(["']?\s*[:=]\s*["']?)([^"'\s,;}{)]{4,})/gi;
/** Long opaque tokens (base64, base64url, hex) that look random. */
const OPAQUE = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;

export interface RedactedText {
  text: string;
  /** Number of values replaced. */
  redactions: number;
}

/**
 * Removes secrets from text before it is sent to an AI provider. Layers, in order:
 * explicit known values, private key blocks, URL credentials and Authorization headers, every built-in secret
 * detector, credential-like assignments, then any long high-entropy token. Over-redaction is accepted;
 * a missed secret is not.
 */
export function redactForPrompt(input: string, knownSecrets: (string | null | undefined)[] = []): RedactedText {
  let count = 0;
  const replace = (label: string) => {
    count++;
    return `[REDACTED:${label}]`;
  };

  let text = input;
  for (const s of [...new Set(knownSecrets.filter((v): v is string => !!v && v.length >= 4))].sort((a, b) => b.length - a.length)) {
    const parts = text.split(s);
    if (parts.length > 1) {
      count += parts.length - 1;
      text = parts.join('[REDACTED:secret]');
    }
  }

  text = text.replace(PEM_BLOCK, () => replace('private-key'));

  // URL credentials and Authorization headers before assignments, so "Authorization: Bearer x" loses x, not "Bearer".
  const before = text.match(/\[redacted\]/g)?.length ?? 0;
  text = new Redactor().redact(text);
  count += (text.match(/\[redacted\]/g)?.length ?? 0) - before;

  for (const rule of BUILTIN_RULES) {
    if (rule.id === 'private-key') continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (match: string, ...groups: unknown[]) => {
      const value = rule.group ? (groups[rule.group - 1] as string | undefined) : match;
      if (!value) return match;
      return match.replace(value, replace(rule.id));
    });
  }

  text = text.replace(ASSIGNMENT, (match: string, key: string, sep: string, value: string) => {
    if (/^\[redacted/i.test(value) || /^(bearer|basic|token)$/i.test(value) || PLACEHOLDER.test(value)) return match;
    return `${key}${sep}${replace('credential')}`;
  });

  text = text.replace(OPAQUE, (token: string) => {
    if (/^[0-9a-f]+$/i.test(token) && token.length <= 40) return token; // commit SHAs and short digests
    return shannonEntropy(token) >= 4 ? replace('token') : token;
  });

  return { text, redactions: count };
}

/** Describes a secret without revealing it, so a model can judge whether it is a placeholder. */
export function describeSecret(value: string): Record<string, unknown> {
  const classes = [/[a-z]/.test(value) && 'lowercase', /[A-Z]/.test(value) && 'uppercase', /\d/.test(value) && 'digits', /[^A-Za-z0-9]/.test(value) && 'symbols'].filter(Boolean);
  const words = ['example', 'sample', 'test', 'dummy', 'fake', 'placeholder', 'changeme', 'xxxx', 'your', 'demo', 'local', 'dev'].filter((w) => value.toLowerCase().includes(w));
  return {
    length: value.length,
    entropyBitsPerChar: Math.round(shannonEntropy(value) * 100) / 100,
    characterClasses: classes,
    repeatedCharacterRatio: value.length ? Math.round((1 - new Set(value).size / value.length) * 100) / 100 : 0,
    looksLikePlaceholder: PLACEHOLDER.test(value),
    containsWords: words,
  };
}

/** Caps text at a character budget, marking the cut. */
export function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 40))}\n[… truncated to fit the context limit]`;
}
