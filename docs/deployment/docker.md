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

If you run MongoDB yourself on such a host, either:
- pin the compose file's `mongo` image to `mongo:7.0`, or
- use a managed service (MongoDB Atlas, Azure Cosmos DB for MongoDB).

Argus supports MongoDB 6 and later. PostgreSQL is not affected.

## Health endpoints

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness: the process is up. Used by the image `HEALTHCHECK`. |
| `GET /readyz` | Readiness. Returns `200` when the database is reachable, otherwise `503`. Also reports the version, role, database type and the last worker heartbeat. |

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

## Upgrading

Pull or build the new image and restart the containers. Migrations run automatically at startup, and are never edited after release.
