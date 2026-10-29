const TIMEOUT_MS = 15_000;

/** A failed call to an external service, with a message that is safe to show to administrators. */
export class IntegrationError extends Error {
  override name = 'IntegrationError';

  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Calls an administrator-configured endpoint. Redirects are refused (a credential must never follow a redirect
 * to another host) and response bodies are reduced to a short, single-line excerpt for error messages.
 */
export async function callExternal(url: string, init: RequestInit & { service: string; timeoutMs?: number }): Promise<Response> {
  const { service, timeoutMs = TIMEOUT_MS, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    throw new IntegrationError(`Could not reach ${service} (${new URL(url).host}): ${cause}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new IntegrationError(`${service} returned HTTP ${res.status}${text ? `: ${text}` : ''}`, res.status);
  }
  return res;
}

/** OAuth 2.0 client-credentials token from Microsoft Entra ID. */
export async function entraToken(loginBase: string, tenantId: string, clientId: string, clientSecret: string, scope: string): Promise<string> {
  const res = await callExternal(`${loginBase}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    service: 'Microsoft Entra ID',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope }).toString(),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new IntegrationError('Microsoft Entra ID did not return an access token.');
  return body.access_token;
}
