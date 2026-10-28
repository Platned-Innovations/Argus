# Configuration

Argus is configured with environment variables, validated at startup. If a value is invalid, the process prints every problem and exits without starting. Empty values are treated as unset.

Runtime policies (password rules, MFA, sessions) are set in the UI under **Administration → Security settings** and stored in the database.

## Environment variables

### Required

| Variable | Description |
|---|---|
| `ARGUS_DB_TYPE` | `postgres` or `mongodb`. |
| `ARGUS_DB_URL` | Connection string, for example `postgres://user:pass@host:5432/argus?sslmode=require` or `mongodb+srv://user:pass@cluster/?retryWrites=true`. |
| `ARGUS_MASTER_KEY` | At least 32 characters. The root key for encryption at rest and token signing. Generate it with `openssl rand -base64 48`. **Changing it invalidates every session, MFA enrollment and stored credential.** See [security](security.md#1-secrets-and-credentials-at-rest). |

### Optional

| Variable | Default | Description |
|---|---|---|
| `ARGUS_DB_NAME` | from the URL, else `argus` | MongoDB database name. |
| `ARGUS_ROLE` | `all` | `all` runs API, UI and worker. `api` runs HTTP only. `worker` runs background processing only. See [architecture](architecture.md#runtime-roles). |
| `ARGUS_ADMIN_PASSWORD` | generated | Initial password for the default `admin` account. Used **only** when the database has no users. It must be changed at first sign-in. |
| `ARGUS_PUBLIC_URL` | — | External URL, for example `https://argus.example.com`. Used for links in emails, and to enable `Secure` cookies and HSTS when it starts with `https://`. |
| `ARGUS_COOKIE_SECURE` | `auto` | `auto` is secure when the public URL is HTTPS (or, without a public URL, when `NODE_ENV=production`). Can also be `true` or `false`. |
| `ARGUS_TRUST_PROXY` | `1` | Express `trust proxy` setting, so client IPs are correct behind a load balancer or App Service front end. Accepts a hop count, `true`, `false`, or a subnet list. |
| `ARGUS_AUTH_RATE_LIMIT` | `10` | Requests per minute per client IP for each credential endpoint (login, MFA verification, password change). Raise it if many users share one egress IP (corporate NAT). |
| `ARGUS_WORKER_CONCURRENCY` | `2` | Maximum concurrent background jobs per worker (from Phase 1). |
| `ARGUS_WEB_DIR` | bundled | Directory containing the built web UI. |
| `PORT` | `8080` | HTTP port. |
| `WEBSITES_PORT` | — | Takes precedence over `PORT`. Set by Azure App Service. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON on stdout. |

## In-app security settings

Under **Administration → Security settings**, visible to administrators and security managers, and editable by administrators:

| Setting | Default | Range |
|---|---|---|
| Require MFA for all users | off | — |
| Minimum password length | 12 | 8–128 |
| Required character classes | 3 | 1–4 |
| Lock after failed attempts | 5 | 3–50 |
| Lockout duration (minutes) | 15 | 1–1440 |
| Access token lifetime (minutes) | 15 | 5–60 |
| Session lifetime (days of inactivity) | 7 | 1–90 |

Every change is recorded in the audit log, with the before and after values.
