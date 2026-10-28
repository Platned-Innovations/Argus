import { type DiscoveredRepo, type Visibility } from '@argus/data';
import { getJson, normalizeBaseUrl, ProviderError } from './http';
import { type ConnectionCheck, MAX_PAGES, type ProviderClient, type ProviderConnection } from './types';

interface GhRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  html_url: string;
  clone_url: string;
  default_branch: string | null;
  private: boolean;
  visibility?: string;
  language: string | null;
  description: string | null;
  archived: boolean;
  pushed_at: string | null;
}

const NAME = 'GitHub';

function nextLink(link: string | null): string | null {
  const m = link?.split(',').find((p) => /rel="next"/.test(p));
  return m ? (/<([^>]+)>/.exec(m)?.[1] ?? null) : null;
}

/** GitHub.com or GitHub Enterprise Server, authenticated with a classic or fine-grained personal access token. */
export class GitHubClient implements ProviderClient {
  private readonly api: URL;
  private readonly webHost: string;

  constructor(private readonly conn: ProviderConnection) {
    if (conn.baseUrl) {
      const base = normalizeBaseUrl(conn.baseUrl);
      // Accept either the server root or its /api/v3 endpoint.
      if (!base.pathname.endsWith('/api/v3')) base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/v3`;
      this.api = base;
      this.webHost = base.host;
    } else {
      this.api = new URL('https://api.github.com');
      this.webHost = 'github.com';
    }
  }

  private url(path: string): string {
    return `${this.api.toString().replace(/\/+$/, '')}${path}`;
  }

  private get<T>(url: string) {
    return getJson<T>(url, {
      headers: { Authorization: `Bearer ${this.conn.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      allowedOrigin: this.api.origin,
      providerName: NAME,
    });
  }

  async check(): Promise<ConnectionCheck> {
    const { data: user } = await this.get<{ login: string }>(this.url('/user'));
    const first = await this.firstPage();
    return { identity: user.login, visibleRepos: first.length };
  }

  private async firstPage(): Promise<GhRepo[]> {
    return (await this.get<GhRepo[]>(await this.listUrl())).data;
  }

  private orgListingMissing = false;

  private async listUrl(): Promise<string> {
    const scope = this.conn.scope?.trim();
    if (!scope || this.orgListingMissing) return this.url('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name');
    const orgUrl = this.url(`/orgs/${encodeURIComponent(scope)}/repos?per_page=100&type=all&sort=full_name`);
    try {
      await this.get<unknown[]>(orgUrl.replace('per_page=100', 'per_page=1'));
      return orgUrl;
    } catch (err) {
      // The scope may be a user account rather than an organisation.
      if (err instanceof ProviderError && err.status === 404) {
        this.orgListingMissing = true;
        return this.url('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name');
      }
      throw err;
    }
  }

  async listRepositories(): Promise<DiscoveredRepo[]> {
    const scope = this.conn.scope?.trim().toLowerCase();
    let url: string | null = await this.listUrl();
    const out: DiscoveredRepo[] = [];
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: { data: GhRepo[]; headers: Headers } = await this.get<GhRepo[]>(url);
      for (const r of res.data) {
        if (this.orgListingMissing && scope && r.owner.login.toLowerCase() !== scope) continue;
        out.push(this.map(r));
      }
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }

  private map(r: GhRepo): DiscoveredRepo {
    const visibility: Visibility = r.visibility === 'internal' ? 'internal' : r.private ? 'private' : 'public';
    return {
      externalId: String(r.id),
      fullName: r.full_name,
      name: r.name,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      visibility,
      language: r.language,
      description: r.description,
      archived: r.archived,
      lastPushedAt: r.pushed_at ? new Date(r.pushed_at) : null,
    };
  }

  gitAuthHeader(): string {
    return `Authorization: Basic ${Buffer.from(`x-access-token:${this.conn.token}`).toString('base64')}`;
  }

  allowedCloneHosts(): string[] {
    return [this.webHost];
  }

  allowsHttpClone(): boolean {
    return this.api.protocol === 'http:';
  }
}
