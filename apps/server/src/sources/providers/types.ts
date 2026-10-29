import { type DiscoveredRepo, type Provider } from '@argus/data';

export interface ProviderConnection {
  provider: Provider;
  baseUrl: string | null;
  scope: string | null;
  username: string | null;
  token: string;
}

export interface ConnectionCheck {
  identity: string | null;
  visibleRepos: number | null;
}

export type WebhookEvent = { kind: 'ping' } | { kind: 'push'; externalId: string; branches: string[] } | { kind: 'ignored'; reason: string };

export interface ProviderClient {
  /** Verifies the credentials and scope. Throws ProviderError with an actionable message. */
  check(): Promise<ConnectionCheck>;
  listRepositories(): Promise<DiscoveredRepo[]>;
  /**
   * Value for git's http.extraHeader so the token never appears in a URL or command line. Async because some
   * credentials (GitHub App installation tokens) are minted on demand.
   */
  gitAuthHeader(): Promise<string>;
  /** Hosts (host[:port]) that clone URLs may point to; anything else is refused before credentials are sent. */
  allowedCloneHosts(): string[];
  /** Whether plain http clone URLs are acceptable (only for loopback development servers). */
  allowsHttpClone(): boolean;
}

/** Safety limit on pagination (pages of 100): 100k repositories per source. */
export const MAX_PAGES = 1000;
