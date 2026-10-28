# Architecture

Argus is a TypeScript monorepo that produces **one Docker image**. The same image serves the web UI and REST API and runs the background worker. A single environment variable (`ARGUS_ROLE`) decides which of these a container does.

```
┌──────────────────────── argus image (node:24, non-root) ────────────────────────┐
│                                                                                 │
│  ARGUS_ROLE=all (default)          ARGUS_ROLE=api          ARGUS_ROLE=worker    │
│  ┌──────────────┐ ┌─────────────┐  ┌──────────────┐        ┌─────────────┐      │
│  │ API + web UI │ │   Worker    │  │ API + web UI │        │   Worker    │      │
│  └──────┬───────┘ └──────┬──────┘  └──────┬───────┘        └──────┬──────┘      │
└─────────┼────────────────┼────────────────┼───────────────────────┼─────────────┘
          └────────────────┴───────┬────────┴───────────────────────┘
                                   │  DataStore interface
                    ┌──────────────┴──────────────┐
             PostgreSQL adapter             MongoDB adapter
           (Kysely + migrations)      (driver + index bootstrap)
```

## Components

| Path | What it is |
|---|---|
| `apps/server` | NestJS application. Its entrypoint (`main.ts`) starts the HTTP API, the worker, or both, depending on `ARGUS_ROLE`. |
| `apps/web` | React single-page app (Vite, Tailwind CSS, TanStack Query). Built to static files, which the API serves in production. |
| `packages/shared` | Types, roles, permissions, validation schemas (zod) and the password policy. Shared by the server and the browser, so both enforce the same rules. |
| `packages/data` | The `DataStore` interface and its two adapters: PostgreSQL and MongoDB. |
| `deploy/` | Dockerfile and docker compose files. Azure infrastructure templates are added in a later phase. |

## Runtime roles

- **`all`**: API, web UI and worker in one process. The simplest deployment, and the one recommended for a single Azure Web App.
- **`api`**: HTTP only. Run several replicas behind a load balancer.
- **`worker`**: background processing only, with no HTTP port.
  - Today: housekeeping (worker heartbeat, expired-session cleanup).
  - Later phases add the scan scheduler, repository scans, advisory-feed ingestion, notifications and Jira sync.

Every role needs only the database. There is **no Redis or message broker**; later phases run the job queue inside the database (a jobs table/collection with leases and retries), so an Azure deployment stays at "one container plus one database".

## Data layer

The application never talks to a database driver directly. It depends on the `DataStore` interface (`packages/data/src/store.ts`), which exposes repositories (`users`, `teams`, `sessions`, `audit`, `settings`, and more in later phases).

| | PostgreSQL | MongoDB |
|---|---|---|
| Library | Kysely + `pg` | Official `mongodb` driver |
| Schema | Versioned, append-only migrations, applied at startup under a lock | Idempotent index bootstrap, version tracked in `_meta` |
| Compatible services | PostgreSQL 14+, Azure Database for PostgreSQL Flexible Server | MongoDB 6+, MongoDB Atlas, Azure Cosmos DB for MongoDB (vCore) |

Both adapters:

- use string UUID identifiers and real timestamps, so the rest of the code is database-neutral
- turn unique-constraint violations into the same `DuplicateKeyError`

The same **contract test suite** (`packages/data/test/contract.test.ts`) runs against a real PostgreSQL container and a real MongoDB container on every CI run. Any behavioural difference between the two is treated as a bug.

The database is chosen with `ARGUS_DB_TYPE`. Data cannot be moved between the two automatically; pick one per installation.

## Request flow (API)

Every request goes through these global guards, in order:

1. **Rate limit**:
   - 300 requests/min per IP in general
   - 10 requests/min per IP on login, MFA and password endpoints (configurable)
2. **CSRF check**: a state-changing request that carries session cookies must echo the CSRF cookie in an `X-CSRF-Token` header.
3. **Authentication**:
   - verifies the short-lived access token (an HttpOnly cookie)
   - **reloads the user from the database**, so a disabled account or a role change takes effect on the very next request
   - rejects tokens issued before the user's last password change
4. **Account restrictions**: accounts that must change their password or enroll in MFA can only reach the endpoints needed to do that.
5. **Authorisation**: each endpoint declares the permissions it needs (for example `users:manage`), and these are checked against the user's role.

Request bodies and query strings are validated with the zod schemas from `packages/shared`.

## Scan lifecycle (from Phase 1)

```
schedule / manual / push webhook
        │
        ▼
 job queued in DB ──► worker leases job ──► shallow clone into /tmp/argus/<run>
                                                   │
                         scanners (secrets, npm, NuGet, frameworks, certificates)
                                                   │
                       findings + dependency inventory (SBOM) stored ◄─┘
                                                   │
                      workspace deleted ─► risk scoring ─► tickets opened/updated/resolved
```

Source code is cloned only for the duration of a scan and is never persisted (see [security](security.md#source-code-handling)).

## Technology choices

- **Node.js 24 LTS and TypeScript.** One language across API, worker and UI. npm is the native environment for analysing npm packages.
- **NestJS 11.** Modules, dependency injection and guards suit a large enterprise codebase.
- **React 19, Vite, Tailwind CSS.** A fast, accessible UI with light and dark modes.
- **argon2id** (`@node-rs/argon2`) for password hashing, and `node:crypto` for every other primitive.
