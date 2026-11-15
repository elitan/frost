# frost-activator

Wakes sleeping (scale-to-zero) workloads on connection. Two modes:

- **standby** (below): a temporary stand-in for a sleeping app service, so it
  wakes on traffic from **other services**, not just on requests to its
  domains.
- **resident** (see [Postgres](#resident-mode-postgres)): a permanent proxy in
  front of a scale-to-zero Postgres branch.

Containers reach each other as `<hostname>.frost.internal` on their Docker
network. That traffic never passes through Caddy, and when a service's
container stops, Docker drops the name, so callers used to get errors.

## How it works

1. When a service goes to sleep, Frost starts `frost-activator-<serviceId>`
   on the service's network, under the same `<hostname>.frost.internal` alias
   and listening on the service's container port.
2. The first connection makes the activator call
   `POST http://host.docker.internal:3091/activate/<serviceId>` (see
   [Wake endpoint](#wake-endpoint)) with a
   per-service token (HMAC of the service id with Frost's JWT secret). Frost
   also requires a private source address.
3. Frost wakes the service (start containers, health check) and answers with
   the containers' IPs. Every connection that arrived meanwhile was held; all
   are now forwarded as raw TCP, so any protocol works (HTTP, gRPC, Postgres).
4. After the wake, Docker resolves the alias to both the activator and the real
   containers. The activator gets out of the way: it exits once idle (10s), or
   after lingering 30s at the first moment no connection is open (hard cutoff
   30s later). It runs with `--rm`, so Docker removes it.

Frost's scale-to-zero tick also reconciles stand-ins under the same per-service
lock as sleep and wake: it restarts missing ones (e.g. after a reboot) and
removes exited leftovers.

Design notes:
- **Standard library only.** No crates, no async runtime: one thread per held
  connection (64 KB stacks), a mutex and condvar for the shared wake.
- **Static musl binary in a `scratch` image: 677 kB.**
- Runs with `--read-only --cap-drop ALL --security-opt no-new-privileges`,
  64 MB memory cap, as user `65534`.
- **Why one per sleeping service:** a container has one IP per network, so one
  shared stand-in couldn't tell which service a caller wanted on a shared port
  (most use 8080). Routing by HTTP `Host` would work for HTTP only.

## Results (Docker Desktop, arm64)

| Check | Result |
|---|---|
| Idle memory, one stand-in | ~1.9 MB (0.5 MB each measured across 20) |
| 20 sleeping services | 10.8 MB of stand-ins vs 173 MB for the same 20 nginx services awake |
| Internal HTTP cold request | 0.13–0.76s |
| Postgres via `psql` (`select 40 + 2`) | 42, ~0.6s including `docker run` |
| 300 concurrent requests, 2s cold start | 300/300, one wake call, 11 MB peak (~35 KB per held connection) |
| Waking 20 services at once, 100 requests | 100/100, median 0.57s, max 0.76s |
| Steady 20 req/s through wake and handover | 912/912; stand-in exited at 18s (2s wake + 15s linger) |
| Frost returns 503 / Frost down | Held connections closed immediately; next connection retries |
| Stand-in deleted (reboot) | Restored within one tick (5s) |
| Project deleted | Stand-ins removed with it |

E2E: `scripts/e2e/group-33-internal-wake.sh` (skips when the image is absent).

## Build and distribution

```bash
apps/activator/build.sh                      # frost-activator:dev for this machine
docker buildx build --platform linux/amd64,linux/arm64 apps/activator
```

The Dockerfile cross-compiles with `rust-lld` on the build machine's
architecture (no emulation) into a `scratch` image.

- **Releases** ship static binaries for amd64 and arm64 in the tarball
  (`activator/<arch>/`, covered by SHA256SUMS). `install.sh` and `update.sh`
  build `frost-activator:<version>` from them with `Dockerfile.prebuilt`;
  nothing is pulled from a registry. Frost uses that tag by default.
- **Source installs** (`install.sh -b <branch>`, git-mode updates) build
  `frost-activator:source` from the checkout and set `FROST_ACTIVATOR_IMAGE`.
- `FROST_ACTIVATOR_IMAGE` overrides the image (local dev: `frost-activator:dev`).

At startup Frost runs the image once on a Docker network
(`frost-activator probe`) to check containers can reach its wake endpoint.
If that fails (no image, or a host firewall blocking containers from the
host), Frost logs why and runs without wake proxies. Nothing breaks:
sleeping services wake only through their domains, and Postgres branches
sleep without a proxy (waking on their public port), as before internal wake
existed.

## Wake endpoint

Frost listens for wake requests on port 3091 (`FROST_ACTIVATOR_PORT`):

- **Linux:** on the default Docker bridge's gateway IP (e.g. `172.17.0.1`),
  which every container network reaches through the host and the internet
  doesn't. Proxies map `host.docker.internal` to that same IP.
- **Docker Desktop:** on `127.0.0.1`; proxies use `host-gateway`.
- `FROST_ACTIVATOR_HOST` overrides the bind address.

Requests also need a per-service (or per-branch) token and a private source
address. A host firewall that drops traffic from Docker networks to the host
blocks wake-ups; the startup probe detects that (see above) and Frost logs
which port to allow.

## Known limitations

- **Thread per connection.** Fine for hundreds of held connections (~35 KB
  each); thousands per sleeping service would want an event loop.
- **One leftover case (standby).** If a service wakes another way (domain,
  API) its idle stand-in stays until its first connection, then exits.
  Harmless, but it holds ~0.5 MB until then.

## Resident mode (Postgres)

Managed Postgres branches (including `main`) with scale to zero get a
resident proxy, `frost-dbproxy-<targetId>`, that owns the branch's internal
hostnames on every environment network for good. The database container
carries no aliases; the proxy forwards to it by container name (resolved on
every connection, so a recreated container with a new IP is followed and a
stale IP can never reach another branch). Traffic is never inspected, so TLS
(`sslmode=require`) passes through end to end.

Why not read the transaction state from the protocol: Frost's Postgres uses
TLS, so the bytes are opaque. Instead:

- **Idle detection** combines Postgres's own view (`pg_stat_activity`: any
  query running or transaction open = busy; idle pooled connections are idle)
  with the proxy's last-byte time (catches short-lived connections that leave
  no session behind) and the public-port gateway's activity.
- **Sleeping** goes through control commands on a loopback port, sent with
  `docker exec <proxy> /frost-activator ctl <cmd>`:
  1. `pause`: new connections are held; client bytes on forwarded
     connections are held back, and any arriving marks the pause "touched".
  2. Frost waits 500 ms and checks `pg_stat_activity` again.
  3. `commit`: atomic. Refuses ("busy") if touched; otherwise closes every
     forwarded connection. Frost then `resume`s (sleep called off) or stops
     Postgres (fast shutdown) and sends `sleep`.
  Held and new connections then ask Frost to wake the database.
- A pause expires after 60 s, so a Frost crash mid-sleep can't wedge it.
- If the forward target stops answering (manual stop, crash, redeploy), the
  proxy asks Frost again, which starts the database if needed.

Frost's database policy tick also reconciles proxies (restarts missing ones,
removes stale ones). If a proxy can't start, the database keeps its hostnames
and doesn't sleep.

### Results (Docker Desktop, arm64, `postgres:17-alpine` with TLS)

| Check | Result |
|---|---|
| TLS through the proxy | TLSv1.3 end to end |
| Cold connection while asleep | 0.45 s standalone; 1.9 s via Frost (it recreates the container) |
| Overhead, 1 client (pgbench -S) | 0.05 ms → 0.09 ms per round trip |
| Overhead, 16 clients | 70–105k tps vs 99–116k direct (trivial queries) |
| 1M-row COPY down and up | checksums match |
| 200 concurrent connections in a cold start | 200/200 |
| Pools across sleeps: node-postgres, postgres.js, pgx | 0 failures, also when querying right after a sleep |
| SQLAlchemy without / with `pool_pre_ping` | first query after each sleep fails / 0 failures |
| Open transaction, running query, recent query | sleep refused, client undisturbed |
| Connection arriving during the pause | held, then woken or resumed |
| Race: 54 forced sleeps under heavy traffic, before `commit` existed | 5 failed queries (query sent between check and shutdown) |
| Same with `commit` (heavy + light traffic, ~11k queries, 50 sleeps) | 0 failures; most sleeps under heavy traffic are correctly refused |
| Proxy restart, DB recreated with new IP, DB stopped behind its back, Frost down, pause never followed up | all recover |
| Memory | ~1 MB idle, 13 MB with 150 open TLS connections (~88 KB each) |

Tests: `src/lib/database-target-proxy.integration.test.ts` (real Docker,
through Frost's runtime functions) and `scripts/e2e/group-34-database-scale-to-zero.sh`
(HTTP API + scheduler). Both skip when the image is missing.

### Known limitations (Postgres)

- A chunk the proxy has read but not yet passed through the gate when
  `commit` takes the lock is dropped (the client sees a closed connection);
  the window is the few instructions between `read` returning and the gate
  check. Closing it fully needs a protocol-aware pooler
  (proxy terminates sessions), which TLS rules out without terminating TLS.
- Queries through the public port (gateway) aren't held back during the
  pause; a long one is still seen by `pg_stat_activity`.
- Short-lived connections only count through the proxy (internal) or the
  gateway (public port); something connecting to the container directly
  wouldn't (nothing does today).
- `LISTEN` sessions are idle by `pg_stat_activity`, so a database whose only
  client is a listener sleeps under it.
- After the database closes a connection, the proxy waits for the client to
  close its side too (half-close), keeping two threads per such connection
  until then. Postgres clients close promptly; same as standby mode.
- With scale to zero on, a manually stopped branch wakes on the next
  connection (as with the public-port gateway).
