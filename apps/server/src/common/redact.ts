const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi;
const AUTH_HEADER = /(authorization:\s*)(basic|bearer|token)\s+\S+/gi;

/**
 * Removes known secret values and credential-shaped substrings from text that may be logged or shown to users
 * (git output, provider error messages).
 */
export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: (string | null | undefined)[] = []) {
    // Longest first so a secret that contains another is fully replaced.
    this.secrets = [...new Set(secrets.filter((s): s is string => !!s && s.length >= 4))].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[redacted]');
    return out.replace(URL_CREDENTIALS, '$1[redacted]@').replace(AUTH_HEADER, '$1$2 [redacted]');
  }
}
