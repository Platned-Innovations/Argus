# Deploying with Docker

## Build the image

From the repository root:

```bash
docker build -f deploy/docker/Dockerfile -t argus:latest .
```

The image is based on `node:24-bookworm-slim`. It runs as the unprivileged `node` user, listens on port **8080**, and includes `git` (used by the scanners) and `tini`.

## docker compose

Two ready-made stacks are provided:

| File | Database |
|---|---|
| `deploy/docker/docker-compose.postgres.yml` | PostgreSQL 17 |
| `deploy/docker/docker-compose.mongo.yml` | MongoDB 8 |

```bash
cp .env.example .env
# Required: set ARGUS_MASTER_KEY.
# Recommended: set POSTGRES_PASSWORD / MONGO_PASSWORD and ARGUS_ADMIN_PASSWORD.
docker compose -f deploy/docker/docker-compose.postgres.yml --env-file .env up -d --build
```

On first start, Argus creates the database schema and the default administrator. If you did not set `ARGUS_ADMIN_PASSWORD`, read the generated password from the log:

```bash
docker compose -f deploy/docker/docker-compose.postgres.yml logs argus | grep "DEFAULT ADMIN"
```

## MongoDB and Linux kernel 6.19+

MongoDB 8.0.x and 8.3.x refuse to start on hosts running Linux kernel 6.19 or newer. They exit with *"Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB"* ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). Ubuntu 26.04 ships such a kernel.

MongoDB only refuses when TCMalloc's per-CPU caches are active. The supplied `docker-compose.mongo.yml` therefore sets `GLIBC_TUNABLES=glibc.pthread.rseq=1` on the `mongo` service, which turns those caches off, so mongod starts on any kernel. The cost is slightly lower memory-allocator throughput. This is the community workaround (see [docker-library/mongo#765](https://github.com/docker-library/mongo/issues/765)), not an upstream fix.

If you run MongoDB yourself on such a host, choose one of:
- set the same environment variable on your `mongo` container
- upgrade to a MongoDB release that supports your kernel, when one is available for your version
- pin the `mongo` image to `mongo:7.0`
- use a managed service (MongoDB Atlas, Azure Cosmos DB for MongoDB)

Argus's own tests run MongoDB the same way, because GitHub's runners now use such kernels.

Argus supports MongoDB 6 and later. PostgreSQL is not affected.

## Health endpoints

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness: the process is up. Used by the image `HEALTHCHECK`. |
| `GET /readyz` | Readiness. Returns `200` when the database is reachable, otherwise `503`. Also reports the version, role, database type and the last worker heartbeat. |
| `GET /metrics` | Prometheus metrics. Off unless `ARGUS_METRICS_TOKEN` is set; send it as `Authorization: Bearer <token>`. |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description of the REST API, generated from the running code. |

### Prometheus

```yaml
scrape_configs:
  - job_name: argus
    scheme: https
    metrics_path: /metrics
    authorization: { type: Bearer, credentials_file: /etc/prometheus/argus-metrics-token }
    static_configs: [{ targets: ['argus.example.com'] }]
```

Metrics are computed from the database, so any one replica reports the whole installation:
- `argus_findings_open{severity}`, `argus_findings_suppressed`, `argus_findings_fixed_7d`
- `argus_tickets_active{severity}`, `argus_tickets_sla_breached`
- `argus_repositories{state}`, `argus_users`, `argus_jobs{type,status}` (queue depth)
- `argus_ai_cost_usd_month`, `argus_intel_items{status}`, `argus_advisories_active`
- `argus_worker_heartbeat_age_seconds`: alert when this exceeds a few minutes, because no worker is running
- `process_resident_memory_bytes`, `process_heap_used_bytes`, `process_uptime_seconds`, `argus_info{version,role,database}`

## Running the image directly

```bash
docker run -d --name argus -p 8080:8080 \
  -e ARGUS_DB_TYPE=postgres \
  -e ARGUS_DB_URL='postgres://argus:secret@db.internal:5432/argus?sslmode=require' \
  -e ARGUS_MASTER_KEY='…' \
  -e ARGUS_PUBLIC_URL='https://argus.example.com' \
  argus:latest
```

## Scaling out

One `ARGUS_ROLE=all` container is enough for most organisations. For more capacity:

- Run **N containers with `ARGUS_ROLE=api`** behind a load balancer. They are stateless, because sessions live in the database.
- Run **M containers with `ARGUS_ROLE=worker`** for scanning throughput.

All containers must share the same database and the same `ARGUS_MASTER_KEY`. Schema migrations are safe when several instances start at once.

## TLS

Terminate TLS at a reverse proxy or load balancer, then set `ARGUS_PUBLIC_URL=https://…` so Argus issues `Secure` cookies and HSTS. `ARGUS_TRUST_PROXY` (default: one hop) makes client IPs correct for rate limiting and the audit log.

## Backups

- **PostgreSQL:** `pg_dump`, or your provider's point-in-time restore.
- **MongoDB:** `mongodump`, or Atlas / Cosmos DB backups.
- **Back up `ARGUS_MASTER_KEY` separately from the database.** A database backup without the key cannot decrypt stored credentials or MFA secrets.
- For a copy of the configuration alone (no secrets, no data), use **Administration → System → Export settings**. See [configuration](../configuration.md#system-branding-and-the-configuration-file).

## Rotating the master key

Rotate `ARGUS_MASTER_KEY` if it may have been exposed, or on a schedule.

1. Back up the database.
2. Stop every Argus container.
3. Run the rotation tool with the current key and the new one, using the same database settings. Try `--dry-run` first.

   ```bash
   docker run --rm --env-file .env -e ARGUS_NEW_MASTER_KEY="$(openssl rand -base64 48)" \
     argus:latest node apps/server/dist/cli.js rotate-master-key --dry-run
   ```

   Then run the same command without `--dry-run`, using the **same** new key. Save it before running.
4. Set `ARGUS_MASTER_KEY` to the new key everywhere, and start Argus.

What the tool does:
- **Re-encrypts every stored credential:** source tokens and webhook secrets, MFA secrets, notification-channel secrets, the Jira token, AI provider keys and the Entra import secret.
- **Preserves existing hashes:** it keeps the keyed-hash key, encrypted with the new key. Refresh tokens, API tokens, MFA recovery codes and the identity of secret findings stay valid, so nobody is signed out and no findings are duplicated.
- **Is safe to re-run:** values already encrypted with the new key are skipped.
- **Reports anything unreadable:** a value it cannot decrypt with either key is listed and left unchanged.

Access tokens signed with the old key expire, and browsers renew them automatically. After the rotation, the old key no longer decrypts anything; retire it.

## Upgrading

Pull or build the new image and restart the containers. Migrations run automatically at startup, and are never edited after release.
