# Development

## Prerequisites

- Node.js 24 (`.nvmrc`)
- Docker, for the integration tests and a local database

## Setup

```bash
npm install
cp .env.example .env            # set ARGUS_MASTER_KEY; point ARGUS_DB_URL at a local database
docker run -d --name argus-pg -e POSTGRES_USER=argus -e POSTGRES_PASSWORD=argus -e POSTGRES_DB=argus -p 5432:5432 postgres:17-alpine
npm run dev
```

`npm run dev` runs three processes:

- the TypeScript compiler in watch mode
- the API server on <http://localhost:8080>, restarting when output changes
- the Vite dev server on <http://localhost:5173>, which proxies `/api` to the server

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compiles the shared, data and server packages (TypeScript project references), then builds the web UI. |
| `npm run typecheck` | Type-checks everything, including tests. |
| `npm run lint` | Runs ESLint. |
| `npm run test:unit` | Runs the server unit tests. These are fast and need no Docker. |
| `npm test` | Runs the data-layer contract tests and the end-to-end API tests against **real PostgreSQL and MongoDB containers** (Testcontainers). |
| `npm run test:browser` | Builds Argus, then runs the Playwright browser tests (below). |

### Browser tests

`e2e/` holds Playwright tests that drive the real UI in Chromium. The global setup starts a PostgreSQL container, a mock GitHub serving a fixture repository with planted secrets, and the **built** server (`apps/server/dist`) serving the built web app, exactly as in production.

The tests cover:
- first sign-in and the forced password change
- every page in the navigation
- connecting a GitHub source, monitoring a repository, the scan, and the tickets it opens
- saved views
- branding

They fail on any uncaught page error or console error, which includes Content-Security-Policy violations.

- One-off setup: `npm run install-browser -w @argus/e2e` (downloads Chromium).
- Run: `npm run test:browser`, or `npm test -w @argus/e2e` after a build.
- Docker must be running. Failures keep a screenshot and a trace in `e2e/test-results/` (`npx playwright show-trace <trace.zip>`).

## Project layout

```
apps/server/src
  auth/        sign-in, sessions, MFA (TOTP), guards, decorators
  users/       user administration, default-admin seeding
  teams/ audit/ settings/ health/
  core/        config-wide singletons: data store, crypto, audit, settings
  worker/      background worker (housekeeping today; scans from Phase 1)
apps/web/src
  pages/       route components (admin/ for administration)
  components/  UI primitives and shared widgets
  lib/         API client (CSRF + silent refresh), auth context
packages/shared  roles, permissions, schemas, password policy (used by server and browser)
packages/data    DataStore interface + postgres/ and mongo/ adapters
e2e              Playwright browser tests
```

## Conventions

- **Validation:** request bodies and queries are validated with the zod schemas in `packages/shared`, and the web UI imports the same schemas.
- **Data access:** only through `DataStore` repositories. A new repository method needs an implementation in **both** adapters and a case in `packages/data/test/contract.test.ts`.
- **Migrations:** PostgreSQL migrations are append-only (`packages/data/src/postgres/migrations.ts`). Never edit a migration that has shipped. For MongoDB, bump `SCHEMA_VERSION` in `mongo/store.ts` when the index definitions change.
- **Auditing:** every security-relevant mutation calls `AuditService.record`. Never put secrets in audit details.
- **Docs:** each phase updates the matching pages in `docs/`. In particular, the status labels in `docs/security.md` and `docs/features/README.md` must match what is actually built.

## Dependency notes

- The root `package.json` pins `multer` through an npm override, so `@nestjs/platform-express` 11 uses a release without known advisories. Remove the override once Nest ships a patched version.
