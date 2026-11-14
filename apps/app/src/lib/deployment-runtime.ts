import type { Selectable } from "kysely";
import { db } from "./db";
import type { Deployments, Services } from "./db-types";
import {
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  transitionDeploymentStatus,
} from "./deployment-status";
import {
  getDeployTimeoutError,
  getDeployTimeoutMs,
  hasDeploymentTimedOut,
} from "./deployment-timeout";
import {
  listFrostContainers as listFrostContainersDefault,
  listManagedContainerStates as listManagedContainerStatesDefault,
  stopContainer as stopContainerDefault,
  stopContainersByLabel as stopContainersByLabelDefault,
} from "./docker";
import { getServiceRuntimeState } from "./service-runtime-status";

const LIVE_CONTAINER_STATUSES = new Set(["running", "restarting", "paused"]);
const RECONCILE_INTERVAL_MS = 15_000;

let listFrostContainersFn = listFrostContainersDefault;
let listManagedContainerStatesFn = listManagedContainerStatesDefault;
let stopContainerFn = stopContainerDefault;
let stopContainersByLabelFn = stopContainersByLabelDefault;

let reconcilerIntervalId: ReturnType<typeof setInterval> | null = null;
let reconcilerTickInFlight = false;

export function setDeploymentRuntimeDockerForTests(fns: {
  listFrostContainers?: typeof listFrostContainersDefault;
  listManagedContainerStates?: typeof listManagedContainerStatesDefault;
  stopContainer?: typeof stopContainerDefault;
  stopContainersByLabel?: typeof stopContainersByLabelDefault;
}): void {
  if (fns.listFrostContainers) listFrostContainersFn = fns.listFrostContainers;
  if (fns.listManagedContainerStates) {
    listManagedContainerStatesFn = fns.listManagedContainerStates;
  }
  if (fns.stopContainer) stopContainerFn = fns.stopContainer;
  if (fns.stopContainersByLabel) {
    stopContainersByLabelFn = fns.stopContainersByLabel;
  }
}

export function resetDeploymentRuntimeDockerForTests(): void {
  listFrostContainersFn = listFrostContainersDefault;
  listManagedContainerStatesFn = listManagedContainerStatesDefault;
  stopContainerFn = stopContainerDefault;
  stopContainersByLabelFn = stopContainersByLabelDefault;
}

function isInProgressDeploymentStatus(
  status: Selectable<Deployments>["status"],
): status is (typeof IN_PROGRESS_DEPLOYMENT_STATUSES)[number] {
  return (IN_PROGRESS_DEPLOYMENT_STATUSES as readonly string[]).includes(
    status,
  );
}

/**
 * Looks up a container state in a `docker ps --no-trunc` snapshot. Stored ids
 * are normally full ids, but tolerate short ids on either side.
 */
export function findContainerState(
  states: Map<string, string>,
  containerId: string,
): string | null {
  const exact = states.get(containerId);
  if (exact !== undefined) {
    return exact;
  }
  if (containerId.length < 12) {
    return null;
  }
  for (const [id, state] of states) {
    if (id.startsWith(containerId) || containerId.startsWith(id)) {
      return state;
    }
  }
  return null;
}

/** Missing from the snapshot means the container was removed. */
export function isContainerStateLive(state: string | null): boolean {
  return state !== null && LIVE_CONTAINER_STATUSES.has(state);
}

export async function stopDeploymentContainers(
  deploymentId: string,
): Promise<void> {
  await stopContainersByLabelFn("frost.deployment.id", deploymentId);

  const deployment = await db
    .selectFrom("deployments")
    .select("containerId")
    .where("id", "=", deploymentId)
    .executeTakeFirst();

  const replicas = await db
    .selectFrom("replicas")
    .select("containerId")
    .where("deploymentId", "=", deploymentId)
    .where("containerId", "is not", null)
    .execute();

  const containerIds = new Set<string>();
  if (deployment?.containerId) {
    containerIds.add(deployment.containerId);
  }

  for (const replica of replicas) {
    if (replica.containerId) {
      containerIds.add(replica.containerId);
    }
  }

  for (const containerId of containerIds) {
    await stopContainerFn(containerId);
  }
}

async function markDeploymentTimedOut(
  deployment: Selectable<Deployments>,
): Promise<boolean> {
  const errorMessage = getDeployTimeoutError();
  const finishedAt = Date.now();

  const applied = await db.transaction().execute(async function onTimeout(trx) {
    const transitioned = await transitionDeploymentStatus(
      deployment.id,
      IN_PROGRESS_DEPLOYMENT_STATUSES,
      "failed",
      { errorMessage, finishedAt, rollbackEligible: false },
      { executor: trx },
    );
    if (!transitioned) {
      return false;
    }

    await trx
      .updateTable("services")
      .set({ currentDeploymentId: null })
      .where("id", "=", deployment.serviceId)
      .where("currentDeploymentId", "=", deployment.id)
      .execute();

    await trx
      .deleteFrom("deploymentLocks")
      .where("deploymentId", "=", deployment.id)
      .execute();
    return true;
  });

  if (!applied) {
    return false;
  }

  await stopDeploymentContainers(deployment.id);
  await db
    .updateTable("replicas")
    .set({ status: "failed" })
    .where("deploymentId", "=", deployment.id)
    .execute();
  return true;
}

async function markDeploymentStopped(deployment: {
  id: string;
  serviceId: string;
  containerId: string;
  finishedAt: number | null;
}): Promise<boolean> {
  const finishedAt = deployment.finishedAt ?? Date.now();

  return db.transaction().execute(async function onStopped(trx) {
    const transitioned = await transitionDeploymentStatus(
      deployment.id,
      ["running"],
      "stopped",
      { finishedAt },
      { executor: trx, expectedContainerId: deployment.containerId },
    );
    if (!transitioned) {
      return false;
    }

    await trx
      .updateTable("services")
      .set({ currentDeploymentId: null })
      .where("id", "=", deployment.serviceId)
      .where("currentDeploymentId", "=", deployment.id)
      .execute();
    return true;
  });
}

async function getLatestDeployment(
  serviceId: string,
): Promise<Selectable<Deployments> | null> {
  const latestDeployment = await db
    .selectFrom("deployments")
    .selectAll()
    .where("serviceId", "=", serviceId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst();

  return latestDeployment ?? null;
}

/**
 * Read-only: derives runtime status from DB state. The background reconciler
 * keeps deployment rows in sync with docker.
 */
export async function addLatestDeploymentWithRuntimeStatus<
  T extends Selectable<Services>,
>(
  service: T,
): Promise<
  T & {
    latestDeployment: Selectable<Deployments> | null;
    runtimeStatus: "not-deployed" | "starting" | "online" | "offline";
    attentionStatus: "updating" | "last-deploy-failed" | null;
  }
> {
  const latestDeployment = await getLatestDeployment(service.id);
  const currentDeploymentId =
    latestDeployment?.status === "stopped" &&
    service.currentDeploymentId === latestDeployment.id
      ? null
      : service.currentDeploymentId;
  const serviceRuntime = getServiceRuntimeState({
    currentDeploymentId,
    latestDeployment,
  });

  return {
    ...service,
    currentDeploymentId,
    latestDeployment,
    runtimeStatus: serviceRuntime.runtimeStatus,
    attentionStatus: serviceRuntime.attentionStatus,
  };
}

export async function addLatestDeploymentsWithRuntimeStatus<
  T extends Selectable<Services>,
>(
  services: T[],
): Promise<
  Array<
    T & {
      latestDeployment: Selectable<Deployments> | null;
      runtimeStatus: "not-deployed" | "starting" | "online" | "offline";
      attentionStatus: "updating" | "last-deploy-failed" | null;
    }
  >
> {
  return Promise.all(services.map(addLatestDeploymentWithRuntimeStatus));
}

export async function failStaleInProgressDeployments(): Promise<number> {
  const cutoff = Date.now() - getDeployTimeoutMs();
  const deployments = await db
    .selectFrom("deployments")
    .selectAll()
    .where("status", "in", [...IN_PROGRESS_DEPLOYMENT_STATUSES])
    .where("createdAt", "<=", cutoff)
    .execute();

  let failedCount = 0;

  for (const deployment of deployments) {
    if (!hasDeploymentTimedOut(deployment.createdAt)) {
      continue;
    }
    if (await markDeploymentTimedOut(deployment)) {
      failedCount += 1;
    }
  }

  return failedCount;
}

/**
 * Marks running deployments whose containers are no longer live as stopped,
 * using a single `docker ps` snapshot. DB rows are read before the snapshot
 * so a container that existed when its row was read is always in it.
 */
export async function reconcileRunningDeployments(): Promise<number> {
  const deployments = await db
    .selectFrom("deployments")
    .select(["id", "serviceId", "containerId", "finishedAt"])
    .where("status", "=", "running")
    .where("containerId", "is not", null)
    .execute();

  if (deployments.length === 0) {
    return 0;
  }

  const replicas = await db
    .selectFrom("replicas")
    .select(["deploymentId", "containerId"])
    .where(
      "deploymentId",
      "in",
      deployments.map(function mapId(deployment) {
        return deployment.id;
      }),
    )
    .where("status", "=", "running")
    .where("containerId", "is not", null)
    .execute();

  const states = await listManagedContainerStatesFn();
  if (!states) {
    return 0;
  }

  const replicaContainerIds = new Map<string, string[]>();
  for (const replica of replicas) {
    if (!replica.containerId) continue;
    const ids = replicaContainerIds.get(replica.deploymentId) ?? [];
    ids.push(replica.containerId);
    replicaContainerIds.set(replica.deploymentId, ids);
  }

  let stoppedCount = 0;
  for (const deployment of deployments) {
    const containerId = deployment.containerId;
    if (!containerId) continue;

    const containerIds = replicaContainerIds.get(deployment.id) ?? [
      containerId,
    ];
    const live = containerIds.some(function isLive(id) {
      return isContainerStateLive(findContainerState(states, id));
    });
    if (live) continue;

    if (await markDeploymentStopped({ ...deployment, containerId })) {
      stoppedCount += 1;
    }
  }

  return stoppedCount;
}

export async function runDeploymentReconcilerTick(): Promise<{
  failedDeployments: number;
  stoppedDeployments: number;
}> {
  const failedDeployments = await failStaleInProgressDeployments();
  const stoppedDeployments = await reconcileRunningDeployments();
  return { failedDeployments, stoppedDeployments };
}

function reconcilerTick(): void {
  if (reconcilerTickInFlight) {
    return;
  }
  reconcilerTickInFlight = true;
  runDeploymentReconcilerTick()
    .then(function onResult(result) {
      if (result.failedDeployments > 0 || result.stoppedDeployments > 0) {
        console.log(
          `[deployment-reconciler] failed ${result.failedDeployments} timed-out deployment(s), stopped ${result.stoppedDeployments} deployment(s) without live containers`,
        );
      }
    })
    .catch(function onError(error) {
      console.error("[deployment-reconciler] Error:", error);
    })
    .finally(function onFinally() {
      reconcilerTickInFlight = false;
    });
}

/** Background loop keeping deployment rows in sync with docker. */
export function startDeploymentReconciler(): void {
  if (reconcilerIntervalId) {
    return;
  }
  reconcilerIntervalId = setInterval(reconcilerTick, RECONCILE_INTERVAL_MS);
  reconcilerIntervalId.unref?.();
  reconcilerTick();
}

export function stopDeploymentReconciler(): void {
  if (!reconcilerIntervalId) {
    return;
  }
  clearInterval(reconcilerIntervalId);
  reconcilerIntervalId = null;
}

async function stopOrphanDeploymentContainers(): Promise<number> {
  const containers = await listFrostContainersFn();
  const deploymentContainers = containers.filter(
    function hasDeploymentId(container) {
      return Boolean(container.labels["frost.deployment.id"]);
    },
  );

  if (deploymentContainers.length === 0) {
    return 0;
  }

  const deploymentIds = [
    ...new Set(
      deploymentContainers
        .map(function mapDeploymentId(container) {
          return container.labels["frost.deployment.id"];
        })
        .filter(function hasValue(value): value is string {
          return Boolean(value);
        }),
    ),
  ];

  const deployments = await db
    .selectFrom("deployments")
    .select(["id", "status", "containerId", "createdAt"])
    .where("id", "in", deploymentIds)
    .execute();

  const staleCutoff = Date.now() - getDeployTimeoutMs();
  const preservedInProgressDeploymentIds = new Set(
    deployments
      .filter(function isFreshInProgress(deployment) {
        return (
          isInProgressDeploymentStatus(deployment.status) &&
          deployment.createdAt > staleCutoff
        );
      })
      .map(function mapId(deployment) {
        return deployment.id;
      }),
  );

  const runningDeploymentIds = deployments
    .filter(function isRunning(deployment) {
      return deployment.status === "running";
    })
    .map(function mapId(deployment) {
      return deployment.id;
    });

  const activeContainerIds = new Set<string>();
  for (const deployment of deployments) {
    if (deployment.status === "running" && deployment.containerId) {
      activeContainerIds.add(deployment.containerId);
    }
  }

  if (runningDeploymentIds.length > 0) {
    const replicas = await db
      .selectFrom("replicas")
      .select("containerId")
      .where("deploymentId", "in", runningDeploymentIds)
      .where("status", "=", "running")
      .where("containerId", "is not", null)
      .execute();

    for (const replica of replicas) {
      if (replica.containerId) {
        activeContainerIds.add(replica.containerId);
      }
    }
  }

  const stoppedContainerIds = new Set<string>();
  for (const container of deploymentContainers) {
    const deploymentId = container.labels["frost.deployment.id"];
    if (deploymentId && preservedInProgressDeploymentIds.has(deploymentId)) {
      continue;
    }
    if (activeContainerIds.has(container.id)) {
      continue;
    }
    await stopContainerFn(container.id);
    stoppedContainerIds.add(container.id);
  }

  return stoppedContainerIds.size;
}

export async function reconcileDeploymentStartupState(): Promise<{
  failedDeployments: number;
  stoppedOrphanContainers: number;
}> {
  const failedDeployments = await failStaleInProgressDeployments();
  const stoppedOrphanContainers = await stopOrphanDeploymentContainers();

  return { failedDeployments, stoppedOrphanContainers };
}
