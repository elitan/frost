# Frost

**Open Source Alternative to Vercel, Netlify, Railway, Render and Neon.**

Build, deploy, and run from one open-source platform.
Your apps run on your server.

Demo: [demo.frost.build](https://demo.frost.build)

## Why Frost

- Open source runtime. No platform markup.
- Git push deploy workflow.
- Docker-native. No Kubernetes setup.
- AI-friendly deploy model with clear logs.

## What you get

- Unlimited services, deploys, and seats
- Automatic SSL (Let's Encrypt)
- Custom domains and redirects
- PR preview environments
- Zero-downtime deploys and instant rollbacks
- Scale to zero: idle services and Postgres databases sleep and wake on the next request or connection
- Health checks, resource limits, persistent volumes
- Managed object storage with S3-compatible buckets and access keys
- REST API

## Core model

- **Project**: container for related services with shared env vars
- **Service**: deployable unit from repo or prebuilt image
- **Object Storage**: S3-compatible API endpoint with buckets and scoped keys
- **Domain**: custom domain attached to a service (proxy or redirect)
- **Deployment**: immutable deploy record with logs and status

Services in one project share a Docker network. Use service name as hostname.

Object storage exposes one user-facing S3 API endpoint. Bucket and access-key
administration lives inside Frost, so users do not need a second public console
domain for the storage engine.

## Install

With AI agent:

- Give your agent `https://frost.build/install.md`

Manual:

```bash
curl -fsSL https://frost.build/install.sh | sudo bash
```

Need VPS provisioning help: [INSTALL.md](INSTALL.md)

## One simple deploy example

Create a project, deploy, then check status:

```bash
PROJECT_ID=$(curl -s -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","repo_url":"./test/fixtures/simple-node","port":3000}' | jq -r .id)

DEPLOYMENT_ID=$(curl -s -X POST "http://localhost:3000/api/projects/$PROJECT_ID/deploy" | jq -r '.deploymentIds[0]')

curl "http://localhost:3000/api/deployments/$DEPLOYMENT_ID"
```

## Docs

- Product docs: [https://frost.build/docs](https://frost.build/docs)
- API docs: `https://<your-frost-host>/api/docs`
- GitHub repo: [https://github.com/elitan/frost](https://github.com/elitan/frost)

## Tech stack

- Bun + Next.js
- SQLite + Kysely
- Tailwind + shadcn/ui
- Docker

## Local development

```bash
bun install
bun run dev
```

Open `http://localhost:3000`

Common test commands:

```bash
bun run e2e:local
bun run e2e:smoke
bun run e2e:changed:fast
```

Useful E2E knobs:

```bash
E2E_GROUPS='04-update,20-setup' bun run e2e:local
E2E_GROUP_GLOB='group-2*.sh' bun run e2e:local
E2E_BATCH_SIZE=4 E2E_START_STAGGER_SEC=1 bun run e2e:local
```

Image pull retries are built in:
`FROST_IMAGE_PULL_RETRIES`, `FROST_IMAGE_PULL_BACKOFF_MS`, `FROST_IMAGE_PULL_MAX_BACKOFF_MS`.

## Backing up Frost itself

Frost snapshots its own SQLite database (`frost.db`: projects, encrypted
secrets, backup configs) with `VACUUM INTO`:

- daily, into `<data-dir>/backups/frost-daily-<timestamp>.db` (last 7 kept)
- right before applying migrations to an existing database, into
  `<data-dir>/backups/frost-pre-migration-<timestamp>.db` (last 5 kept)

If a Postgres backup S3 destination is enabled, each daily snapshot is also
uploaded to `s3://<bucket>/<prefix>/frost-system/` and kept for 14 days. With
several destinations, the oldest enabled one (by creation time) is used.
Status is shown under Settings > Frost Database Backups and at
`GET /api/settings/system-backup`.

Snapshots contain encrypted secrets; keep `FROST_JWT_SECRET` (in
`/opt/frost/.env`) backed up separately or they cannot be decrypted.

To restore (default install, data in `/opt/frost/data`):

```bash
systemctl stop frost
# release installs: /opt/frost/scripts, git installs: /opt/frost/apps/app/scripts
/opt/frost/scripts/restore-frost-db.sh /opt/frost/data/backups/frost-daily-<timestamp>.db
# or by hand: rm -f frost.db-wal frost.db-shm && cp <snapshot> /opt/frost/data/frost.db
systemctl start frost
```

For an offsite copy, download it from the bucket first. The script saves the
current `frost.db` next to it before overwriting.

## Requirements

- VPS/server with Docker
- Ubuntu 20.04+ recommended

## License

MIT
