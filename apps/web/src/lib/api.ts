import { type ApiErrorBody } from '@argus/shared';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    const msg = body?.message;
    super(Array.isArray(msg) ? msg.join(' ') : msg || `Request failed (${status})`);
  }

  get code(): string | undefined {
    return this.body?.code;
  }

  /** Human-readable message including field-level validation issues. */
  get details(): string[] {
    const issues = this.body?.issues?.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)) ?? [];
    const msg = this.body?.message;
    return issues.length ? issues : Array.isArray(msg) ? msg : [this.message];
  }
}

function readCookie(name: string): string {
  return (
    document.cookie
      .split('; ')
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Notified when the session is gone and could not be refreshed. */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

const NO_REFRESH = new Set(['/auth/login', '/auth/mfa/verify', '/auth/refresh', '/auth/logout']);
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const attempt = () => fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'x-csrf-token': decodeURIComponent(readCookie('argus_csrf')) } });
    let res = await attempt();
    if (!res.ok && readCookie('argus_csrf')) {
      // Another tab may have rotated the token a moment ago; its new cookie is now in the shared jar.
      await new Promise((r) => setTimeout(r, 800));
      res = await attempt();
    }
    return res.ok;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const send = () =>
    fetch(`${BASE}${path}${buildQuery(opts.query)}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        'x-csrf-token': decodeURIComponent(readCookie('argus_csrf')),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && !NO_REFRESH.has(path)) {
    if (await refreshSession()) res = await send();
    else unauthorizedListeners.forEach((fn) => fn());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
