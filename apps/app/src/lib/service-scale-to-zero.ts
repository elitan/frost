import { getContainerNetworkBytes as getContainerNetworkBytesDefault } from "./container-network-stats";
import { db } from "./db";
import {
  startContainer as startContainerDefault,
  stopContainerKeepingIt as stopContainerDefault,
  waitForHealthy as waitForHealthyDefault,
} from "./docker";
import { syncCaddyConfig as syncCaddyConfigDefault } from "./domains";
import { withLock } from "./keyed-lock";

const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 30;
const DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS = 60;

/**
 * A service whose current deployment is running. Scale-to-zero applies to
 * services whose current deployment has `scaleToZeroMinutes` set (the
 * service setting, or frost.yaml, captured at deploy time).
 */
export interface ScaleToZeroService {
  serviceId: string;
  deploymentId: string;
  scaleToZeroMinutes: number | null;
  lastActivityAt: number | null;
  sleepingSince: number | null;
  shutdownTimeout: number | null;
  healthCheckPath: string | null;
  healthCheckTimeout: number | null;
  /** When the deployment went live; idle time is never counted before it. */
  liveSince: number;
  containers: Array<{ containerId: string; hostPort: number }>;
}

export class ServiceWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceWakeError";
  }
}

interface Deps {
  getNow: () => number;
  getContainerNetworkBytes: (containerId: string) => Promise<number | null>;
  startContainer: (containerId: string) => Promise<void>;
  stopContainer: (containerId: string, timeoutSeconds: number) => Promise<void>;
  waitForHealthy: typeof waitForHealthyDefault;
  syncCaddyConfig: () => Promise<unknown>;
}

const defaultDeps: Deps = {
  getNow: Date.now,
  getContainerNetworkBytes: getContainerNetworkBytesDefault,
  startContainer: startContainerDefault,
  stopContainer: stopContainerDefault,
  waitForHealthy: waitForHealthyDefault,
  syncCaddyConfig: syncCaddyConfigDefault,
};

let deps: Deps = defaultDeps;

export function setScaleToZeroDepsForTests(overrides: Partial<Deps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function resetScaleToZeroStateForTests(): void {
  deps = defaultDeps;
  lastNetworkBytes.clear();
  activeProxyConnections.clear();
  wakesInFlight.clear();
}

/** Last measured network byte total per deployment (all replicas). */
const lastNetworkBytes = new Map<string, number>();
/** Connections the wake server is currently proxying, per service. */
const activeProxyConnections = new Map<string, number>();
const wakesInFlight = new Map<string, Promise<number[]>>();

function lockKey(serviceId: string): string {
  return `service-scale-to-zero:${serviceId}`;
}

export function trackProxyConnection(serviceId: string): () => void {
  activeProxyConnections.set(
    serviceId,
    (activeProxyConnections.get(serviceId) ?? 0) + 1,
  );
  let released = false;
  return function releaseProxyConnection() {
    if (released) return;
    released = true;
    const next = (activeProxyConnections.get(serviceId) ?? 1) - 1;
    if (next <= 0) {
      activeProxyConnections.delete(serviceId);
    } else {
      activeProxyConnections.set(serviceId, next);
    }
  };
}

export function getActiveProxyConnections(serviceId: string): number {
  return activeProxyConnections.get(serviceId) ?? 0;
}

export function isServiceIdleDue(input: {
  lastActivityAt: number | null;
  liveSince: number;
  scaleToZeroMinutes: number;
  now: number;
}): boolean {
  const idleSince = Math.max(input.lastActivityAt ?? 0, input.liveSince);
  return input.now - idleSince >= input.scaleToZeroMinutes * 60_000;
}

function runningServicesQuery() {
  return db
    .selectFrom("services")
    .innerJoin("deployments", "deployments.id", "services.currentDeploymentId")
    .select([
      "services.id as serviceId",
      "services.lastActivityAt",
      "services.sleepingSince",
      "services.shutdownTimeout",
      "deployments.id as deploymentId",
      "deployments.scaleToZeroMinutes",
      "deployments.healthCheckPath",
      "deployments.healthCheckTimeout",
      "deployments.containerId",
      "deployments.hostPort",
      "deployments.finishedAt",
      "deployments.createdAt",
    ])
    .where("deployments.status", "=", "running")
    .where("services.serviceType", "=", "app");
}

type RunningServiceRow = Awaited<
  ReturnType<ReturnType<typeof runningServicesQuery>["execute"]>
>[number];

async function attachContainers(
  rows: RunningServiceRow[],
): Promise<ScaleToZeroService[]> {
  if (rows.length === 0) {
    return [];
  }
  const replicas = await db
    .selectFrom("replicas")
    .select(["deploymentId", "containerId", "hostPort"])
    .where(
      "deploymentId",
      "in",
      rows.map(function mapId(row) {
        return row.deploymentId;
      }),
    )
    .where("status", "=", "running")
    .orderBy("replicaIndex")
    .execute();

  return rows.map(function toService(row) {
    const containers: ScaleToZeroService["containers"] = [];
    for (const replica of replicas) {
      if (
        replica.deploymentId === row.deploymentId &&
        replica.containerId &&
        replica.hostPort
      ) {
        containers.push({
          containerId: replica.containerId,
          hostPort: replica.hostPort,
        });
      }
    }
    // Deployments from before replicas existed only have the single
    // container on the deployment row.
    if (containers.length === 0 && row.containerId && row.hostPort) {
      containers.push({ containerId: row.containerId, hostPort: row.hostPort });
    }
    return {
      serviceId: row.serviceId,
      deploymentId: row.deploymentId,
      scaleToZeroMinutes: row.scaleToZeroMinutes,
      lastActivityAt: row.lastActivityAt,
      sleepingSince: row.sleepingSince,
      shutdownTimeout: row.shutdownTimeout,
      healthCheckPath: row.healthCheckPath,
      healthCheckTimeout: row.healthCheckTimeout,
      liveSince: row.finishedAt ?? row.createdAt,
      containers,
    };
  });
}

export async function getScaleToZeroService(
  serviceId: string,
): Promise<ScaleToZeroService | null> {
  const rows = await runningServicesQuery()
    .where("services.id", "=", serviceId)
    .execute();
  const [service] = await attachContainers(rows);
  return service ?? null;
}

async function listScaleToZeroCandidates(): Promise<ScaleToZeroService[]> {
  const rows = await runningServicesQuery()
    .where("deployments.scaleToZeroMinutes", "is not", null)
    .where("services.sleepingSince", "is", null)
    .execute();
  return attachContainers(rows);
}

/** Container ids of sleeping services; cleanup must not remove these. */
export async function listSleepingContainerIds(): Promise<string[]> {
  const rows = await runningServicesQuery()
    .where("services.sleepingSince", "is not", null)
    .execute();
  const services = await attachContainers(rows);
  return services.flatMap(function mapIds(service) {
    return service.containers.map(function mapId(container) {
      return container.containerId;
    });
  });
}

async function measureNetworkBytes(
  service: ScaleToZeroService,
): Promise<number | null> {
  let total = 0;
  for (const container of service.containers) {
    const bytes = await deps.getContainerNetworkBytes(container.containerId);
    if (bytes === null) {
      return null;
    }
    total += bytes;
  }
  return total;
}

async function markActivity(serviceId: string, now: number): Promise<void> {
  await db
    .updateTable("services")
    .set({ lastActivityAt: now })
    .where("id", "=", serviceId)
    .execute();
}

/**
 * Puts a service to sleep: routes its domains to the wake server, then stops
 * (without removing) its containers. Unless `force` is set, it only sleeps
 * when scale-to-zero is enabled and the service is still idle.
 */
export async function sleepService(
  serviceId: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  return withLock(lockKey(serviceId), async function sleepLocked() {
    const service = await getScaleToZeroService(serviceId);
    if (!service || service.sleepingSince !== null) {
      return false;
    }
    if (service.containers.length === 0) {
      return false;
    }
    const now = deps.getNow();
    if (!options.force) {
      if (service.scaleToZeroMinutes === null) return false;
      if (getActiveProxyConnections(serviceId) > 0) return false;
      if (
        !isServiceIdleDue({
          lastActivityAt: service.lastActivityAt,
          liveSince: service.liveSince,
          scaleToZeroMinutes: service.scaleToZeroMinutes,
          now,
        })
      ) {
        return false;
      }
    }

    // Conditional on the deployment so a deploy that went live meanwhile is
    // never marked as sleeping.
    const result = await db
      .updateTable("services")
      .set({ sleepingSince: now })
      .where("id", "=", serviceId)
      .where("currentDeploymentId", "=", service.deploymentId)
      .where("sleepingSince", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      return false;
    }

    // Route traffic to the wake server before stopping anything.
    try {
      await deps.syncCaddyConfig();
    } catch (error) {
      await db
        .updateTable("services")
        .set({ sleepingSince: null })
        .where("id", "=", serviceId)
        .execute();
      throw error;
    }

    const timeout = service.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
    for (const container of service.containers) {
      try {
        await deps.stopContainer(container.containerId, timeout);
      } catch (error) {
        console.error("[scale-to-zero] Failed to stop container", {
          serviceId,
          containerId: container.containerId,
          error,
        });
      }
    }
    lastNetworkBytes.delete(service.deploymentId);
    console.log(`[scale-to-zero] Service ${serviceId} is now sleeping`);
    return true;
  });
}

/**
 * After a failed wake, stop whatever did start so the service is fully
 * asleep again. Nothing else would stop it: the scheduler and reconciler
 * both skip sleeping services.
 */
async function stopAfterFailedWake(service: ScaleToZeroService): Promise<void> {
  const timeout = service.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_SECONDS;
  for (const container of service.containers) {
    try {
      await deps.stopContainer(container.containerId, timeout);
    } catch {
      // Already stopped or gone.
    }
  }
}

async function wakeServiceLocked(serviceId: string): Promise<number[]> {
  const service = await getScaleToZeroService(serviceId);
  if (!service || service.containers.length === 0) {
    throw new ServiceWakeError("Service has no running deployment");
  }
  const ports = service.containers.map(function mapPort(container) {
    return container.hostPort;
  });
  const now = deps.getNow();

  if (service.sleepingSince === null) {
    await markActivity(serviceId, now);
    return ports;
  }

  console.log(`[scale-to-zero] Waking service ${serviceId}`);
  try {
    for (const container of service.containers) {
      await deps.startContainer(container.containerId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No such container")) {
      // The containers are gone, so there is nothing to wake. Clear the
      // flag so the deployment reconciler marks the deployment stopped.
      await db
        .updateTable("services")
        .set({ sleepingSince: null })
        .where("id", "=", serviceId)
        .execute();
    } else {
      await stopAfterFailedWake(service);
    }
    throw new ServiceWakeError(`Failed to start service: ${message}`);
  }

  const timeoutSeconds =
    service.healthCheckTimeout ?? DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS;
  const healthy = await Promise.all(
    service.containers.map(function checkHealth(container) {
      return deps.waitForHealthy({
        containerId: container.containerId,
        port: container.hostPort,
        path: service.healthCheckPath,
        timeoutSeconds,
      });
    }),
  );
  if (healthy.includes(false)) {
    await stopAfterFailedWake(service);
    throw new ServiceWakeError("Service failed its health check after waking");
  }

  await db
    .updateTable("services")
    .set({ sleepingSince: null, lastActivityAt: deps.getNow() })
    .where("id", "=", serviceId)
    .execute();

  try {
    await deps.syncCaddyConfig();
  } catch (error) {
    // The wake server keeps proxying until the Caddy reconciler catches up.
    console.error("[scale-to-zero] Caddy sync after wake failed", error);
  }
  console.log(`[scale-to-zero] Service ${serviceId} is awake`);
  return ports;
}

/**
 * Makes sure a service's containers are running and healthy, starting them
 * if it is asleep. Concurrent callers share one wake. Returns host ports.
 */
export function ensureServiceAwake(serviceId: string): Promise<number[]> {
  const existing = wakesInFlight.get(serviceId);
  if (existing) {
    return existing;
  }
  const wake = withLock(lockKey(serviceId), function wakeLocked() {
    return wakeServiceLocked(serviceId);
  }).finally(function clearInFlight() {
    wakesInFlight.delete(serviceId);
  });
  wakesInFlight.set(serviceId, wake);
  return wake;
}

/**
 * One scheduler pass: records network activity for every scale-to-zero
 * service and puts idle ones to sleep.
 */
export async function runScaleToZeroTick(): Promise<{ slept: string[] }> {
  const now = deps.getNow();
  const slept: string[] = [];
  const candidates = await listScaleToZeroCandidates();
  const liveDeploymentIds = new Set(
    candidates.map(function mapId(service) {
      return service.deploymentId;
    }),
  );
  for (const deploymentId of lastNetworkBytes.keys()) {
    if (!liveDeploymentIds.has(deploymentId)) {
      lastNetworkBytes.delete(deploymentId);
    }
  }

  for (const service of candidates) {
    if (service.scaleToZeroMinutes === null) continue;
    if (service.containers.length === 0) continue;

    const bytes = await measureNetworkBytes(service);
    if (bytes === null) {
      // Can't tell whether it is in use, so leave it running.
      continue;
    }
    const previous = lastNetworkBytes.get(service.deploymentId);
    lastNetworkBytes.set(service.deploymentId, bytes);
    if (previous !== undefined && previous !== bytes) {
      await markActivity(service.serviceId, now);
      continue;
    }
    // The first measurement only sets a baseline.
    if (previous === undefined) continue;
    if (getActiveProxyConnections(service.serviceId) > 0) continue;
    if (
      !isServiceIdleDue({
        lastActivityAt: service.lastActivityAt,
        liveSince: service.liveSince,
        scaleToZeroMinutes: service.scaleToZeroMinutes,
        now,
      })
    ) {
      continue;
    }

    try {
      if (await sleepService(service.serviceId)) {
        slept.push(service.serviceId);
      }
    } catch (error) {
      console.error("[scale-to-zero] Failed to put service to sleep", {
        serviceId: service.serviceId,
        error,
      });
    }
  }

  return { slept };
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

function getCheckIntervalMs(): number {
  const raw = Number.parseInt(
    process.env.FROST_SCALE_TO_ZERO_INTERVAL_MS ?? "",
    10,
  );
  return Number.isInteger(raw) && raw >= 1000 ? raw : DEFAULT_CHECK_INTERVAL_MS;
}

function tick(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  runScaleToZeroTick()
    .catch(function onError(error) {
      console.error("[scale-to-zero] Tick failed", error);
    })
    .finally(function onDone() {
      tickInFlight = false;
    });
}

export function startScaleToZeroScheduler(): void {
  if (intervalId) return;
  intervalId = setInterval(tick, getCheckIntervalMs());
  intervalId.unref?.();
  tick();
}

export function stopScaleToZeroScheduler(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
