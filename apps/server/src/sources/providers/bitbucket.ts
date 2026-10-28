import { type DiscoveredRepo } from '@argus/data';
import { basicAuth, getJson, normalizeBaseUrl, ProviderError, stripUserInfo } from './http';
import { type ConnectionCheck, MAX_PAGES, type ProviderClient, type ProviderConnection } from './types';

interface CloudRepo {
  uuid: string;
  full_name: string;
  name: string;
  is_private: boolean;
  language: string | null;
  description: string | null;
  updated_on: string | null;
  mainbranch?: { name: string } | null;
  links: { html?: { href: string }; clone?: { name: string; href: string }[] };
}

interface CloudPage<T> {
  values: T[];
  next?: string;
  size?: number;
}

/**
 * Bitbucket Cloud. Credentials are either a workspace/repository access token (no username),
 * or an Atlassian API token / app password together with the account email or username.
 */
export class BitbucketCloudClient implements ProviderClient {
  private readonly api = new URL('https://api.bitbucket.org/2.0');
  private readonly name = 'Bitbucket Cloud';

  constructor(private readonly conn: ProviderConnection) {
    if (!conn.scope?.trim()) throw new ProviderError('A Bitbucket Cloud workspace is required.', null, true);
  }

  private authorization(): string {
    return this.conn.username ? basicAuth(this.conn.username, this.conn.token) : `Bearer ${this.conn.token}`;
  }

  private get<T>(url: string) {
    return getJson<T>(url, { headers: { Authorization: this.authorization() }, allowedOrigin: this.api.origin, providerName: this.name });
  }

  private reposUrl(pagelen: number): string {
    return `${this.api.toString()}/repositories/${encodeURIComponent(this.conn.scope!.trim())}?pagelen=${pagelen}&sort=full_name`;
  }

  async check(): Promise<ConnectionCheck> {
    const { data } = await this.get<CloudPage<CloudRepo>>(this.reposUrl(10));
    let identity: string | null = null;
    if (this.conn.username) {
      identity = await this.get<{ display_name?: string; username?: string }>(`${this.api.toString()}/user`)
        .then((r) => r.data.username ?? r.data.display_name ?? null)
        .catch(() => this.conn.username);
    }
    return { identity: identity ?? 'access token', visibleRepos: data.size ?? data.values.length };
  }

  async listRepositories(): Promise<DiscoveredRepo[]> {
    let url: string | undefined = this.reposUrl(100);
    const out: DiscoveredRepo[] = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: { data: CloudPage<CloudRepo> } = await this.get<CloudPage<CloudRepo>>(url);
      for (const r of res.data.values) {
        const clone = r.links.clone?.find((c) => c.name === 'https')?.href;
        if (!clone) continue;
        out.push({
          externalId: r.uuid,
          fullName: r.full_name,
          name: r.name,
          htmlUrl: r.links.html?.href ?? null,
          cloneUrl: stripUserInfo(clone),
          defaultBranch: r.mainbranch?.name ?? null,
          visibility: r.is_private ? 'private' : 'public',
          language: r.language || null,
          description: r.description || null,
          archived: false,
          lastPushedAt: r.updated_on ? new Date(r.updated_on) : null,
        });
      }
      url = res.data.next;
    }
    return out;
  }

  gitAuthHeader(): string {
    const header = this.conn.username ? basicAuth(this.conn.username, this.conn.token) : basicAuth('x-token-auth', this.conn.token);
    return `Authorization: ${header}`;
  }

  allowedCloneHosts(): string[] {
    return ['bitbucket.org'];
  }

  allowsHttpClone(): boolean {
    return false;
  }
}

interface ServerRepo {
  id: number;
  slug: string;
  name: string;
  description?: string;
  public?: boolean;
  archived?: boolean;
  project: { key: string };
  links: { self?: { href: string }[]; clone?: { name: string; href: string }[] };
}

interface ServerPage<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
  size?: number;
}

/**
 * Bitbucket Data Center / Server, authenticated with an HTTP access token (bearer) or username + token.
 * The scope, when set, is a project key.
 */
export class BitbucketServerClient implements ProviderClient {
  private readonly base: URL;
  private readonly name = 'Bitbucket Data Center';

  constructor(private readonly conn: ProviderConnection) {
    if (!conn.baseUrl) throw new ProviderError('The Bitbucket Data Center server URL is required.', null, true);
    this.base = normalizeBaseUrl(conn.baseUrl);
  }

  private authorization(): string {
    return this.conn.username ? basicAuth(this.conn.username, this.conn.token) : `Bearer ${this.conn.token}`;
  }

  private get<T>(url: string) {
    return getJson<T>(url, { headers: { Authorization: this.authorization() }, allowedOrigin: this.base.origin, providerName: this.name });
  }

  private reposUrl(start: number, limit: number): string {
    const root = `${this.base.toString().replace(/\/+$/, '')}/rest/api/1.0`;
    const scope = this.conn.scope?.trim();
    const path = scope ? `/projects/${encodeURIComponent(scope)}/repos` : '/repos';
    return `${root}${path}?limit=${limit}&start=${start}`;
  }

  async check(): Promise<ConnectionCheck> {
    const { data, headers } = await this.get<ServerPage<ServerRepo>>(this.reposUrl(0, 25));
    return { identity: headers.get('x-ausername') ?? this.conn.username ?? null, visibleRepos: data.isLastPage ? data.values.length : (data.size ?? data.values.length) };
  }

  async listRepositories(): Promise<DiscoveredRepo[]> {
    const out: DiscoveredRepo[] = [];
    let start: number | undefined = 0;
    for (let page = 0; start !== undefined && page < MAX_PAGES; page++) {
      const res: { data: ServerPage<ServerRepo> } = await this.get<ServerPage<ServerRepo>>(this.reposUrl(start, 100));
      for (const r of res.data.values) {
        const clone = r.links.clone?.find((c) => c.name === 'http')?.href;
        if (!clone) continue;
        out.push({
          externalId: String(r.id),
          fullName: `${r.project.key}/${r.slug}`,
          name: r.name,
          htmlUrl: r.links.self?.[0]?.href ?? null,
          cloneUrl: stripUserInfo(clone),
          // Resolved at clone time from the remote HEAD (avoids one API call per repository).
          defaultBranch: null,
          visibility: r.public ? 'public' : 'private',
          language: null,
          description: r.description || null,
          archived: r.archived ?? false,
          lastPushedAt: null,
        });
      }
      start = res.data.isLastPage ? undefined : res.data.nextPageStart;
    }
    return out;
  }

  gitAuthHeader(): string {
    return `Authorization: ${this.authorization()}`;
  }

  allowedCloneHosts(): string[] {
    return [this.base.host];
  }

  allowsHttpClone(): boolean {
    return this.base.protocol === 'http:';
  }
}
