import { type IncomingMessage, type ServerResponse } from 'node:http';

export const LODASH_GHSA = 'GHSA-35jh-r3h4-6jhm';

/** A package-lock.json with lodash at the given version and a GPL-licensed dependency. */
export function lockfile(lodash: string) {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'shop', dependencies: { lodash: `^${lodash}`, 'gpl-lib': '1.0.0' } },
      'node_modules/lodash': { version: lodash, license: 'MIT' },
      'node_modules/gpl-lib': { version: '1.0.0', license: 'GPL-3.0-only' },
    },
  });
}

/** Environment pointing every intel source at the mock server. */
export function intelEnv(baseUrl: string): Record<string, string> {
  const intel = `${baseUrl}/intel`;
  return {
    ARGUS_OSV_URL: `${intel}/osv`,
    ARGUS_KEV_URL: `${intel}/kev.json`,
    ARGUS_EPSS_URL: `${intel}/epss`,
    ARGUS_EOL_URL: `${intel}/eol`,
    ARGUS_NPM_REGISTRY_URL: `${intel}/npm`,
    ARGUS_NUGET_URL: `${intel}/nuget`,
  };
}

/** Intel endpoints served by the mock: OSV, CISA KEV, EPSS, endoflife.date, npm and NuGet registries. */
export function intelRoutes(calls: Map<string, number>) {
  const count = (k: string) => calls.set(k, (calls.get(k) ?? 0) + 1);
  return (_req: IncomingMessage, url: URL, body: string, res: ServerResponse) => {
    const json = (data: unknown, status = 200) => (res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)), true);
    const p = url.pathname;
    if (p === '/intel/osv/v1/querybatch') {
      count('osv-query');
      const { queries } = JSON.parse(body) as { queries: { package: { name: string }; version: string }[] };
      return json({ results: queries.map((q) => (q.package.name === 'lodash' && q.version === '4.17.20' ? { vulns: [{ id: LODASH_GHSA, modified: '2026-01-01T00:00:00Z' }] } : {})) });
    }
    if (p === `/intel/osv/v1/vulns/${LODASH_GHSA}`) {
      count('osv-vuln');
      return json({
        id: LODASH_GHSA,
        summary: 'Command Injection in lodash',
        details: 'lodash versions prior to 4.17.21 are vulnerable to Command Injection via the template function.',
        aliases: ['CVE-2021-23337'],
        modified: '2026-01-01T00:00:00Z',
        published: '2021-02-15T00:00:00Z',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
        references: [{ type: 'ADVISORY', url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337' }],
      });
    }
    if (p === '/intel/kev.json') return json({ vulnerabilities: [{ cveID: 'CVE-2021-23337' }, { cveID: 'CVE-2020-0001' }] });
    if (p === '/intel/epss') return json({ data: (url.searchParams.get('cve') ?? '').split(',').filter((c) => c === 'CVE-2021-23337').map((cve) => ({ cve, epss: '0.40000' })) });
    if (p === '/intel/eol/api/dotnet.json')
      return json([
        { cycle: '8', eol: '2026-11-10', lts: true },
        { cycle: '6', eol: '2024-11-12', lts: true },
      ]);
    if (p.startsWith('/intel/eol/')) return json({ error: 'unknown product' }, 404);
    if (p === '/intel/npm/lodash/latest') return json({ version: '4.17.21' });
    if (p.startsWith('/intel/npm/')) return json({});
    if (p === '/intel/nuget/newtonsoft.json/index.json') return json({ versions: ['12.0.3', '13.0.1', '13.0.4-beta1'] });
    if (p.startsWith('/intel/')) return json({}, 404);
    return false;
  };
}

