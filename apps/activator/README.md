# frost-activator (experiment)

A tiny stand-in that lets a sleeping (scale-to-zero) service wake on traffic
from **other services**, not just on requests to its domains.

Containers reach each other as `<hostname>.frost.internal` on their Docker
network. That traffic never passes through Caddy, and when a service's
container stops, Docker drops the name, so callers used to get errors.

## How it works

1. When a service goes to sleep, Frost starts `frost-activator-<serviceId>`
   on the service's network, under the same `<hostname>.frost.internal` alias
   and listening on the service's container port.
2. The first connection makes the activator call
   `POST http://host.docker.internal:3091/activate/<serviceId>` with a
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

## Build

```bash
apps/activator/build.sh            # host arch (aarch64 on Apple silicon)
apps/activator/build.sh x86_64     # needs: rustup target add x86_64-unknown-linux-musl
```

## Open issues before shipping

- **Distribution.** Installs don't have Rust. Publish a multi-arch image
  (amd64/arm64) from CI, e.g. GHCR, pinned by digest in Frost.
- **Control port exposure.** The control server binds `0.0.0.0:3091` so
  containers can reach it through their network gateway. Requests need a
  per-service token and a private source address, but binding only to the
  Docker bridge gateways (or a firewall rule) would be tighter.
- **Stale pooled connections (Postgres).** Idle detection counts traffic, so a
  database whose clients hold idle pooled connections can sleep under them;
  the clients' next query fails and they reconnect (which wakes it). A
  Postgres-aware idle check (`pg_stat_activity`) would avoid that.
- **Thread per connection.** Fine for hundreds of held connections (~35 KB
  each); thousands per sleeping service would want an event loop.
- **One activator leftover case.** If a service wakes another way (domain, API)
  its idle stand-in stays until its first connection, then exits. Harmless,
  but it holds ~0.5 MB until then.
