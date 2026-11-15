import { describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { db } from "./db";
import {
  failStaleInProgressDeployments,
  findContainerState,
  reconcileDeploymentStartupState,
  reconcileRunningDeployments,
  resetDeploymentRuntimeDockerForTests,
  setDeploymentRuntimeDockerForTests,
} from "./deployment-runtime";
import {
  getDeployTimeoutError,
  getDeployTimeoutMs,
} from "./deployment-timeout";

interface TestFixture {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

async function createFixture(): Promise<TestFixture> {
  const suffix = nanoid(8);
  const projectId = `proj-deploy-runtime-${suffix}`;
  const environmentId = `env-deploy-runtime-${suffix}`;
  const serviceId = `svc-deploy-runtime-${suffix}`;
  const now = Date.now();

  await db
    .insertInto("projects")
    .values({
      id: projectId,
      name: `deploy-runtime-${suffix}`,
      envVars: "[]",
      createdAt: now,
    })
    .execute();

  await db
    .insertInto("environments")
    .values({
      id: environmentId,
      projectId,
      name: "production",
      type: "production",
      isEphemeral: false,
      createdAt: now,
    })
    .execute();

  await db
    .insertInto("services")
    .values({
      id: serviceId,
      environmentId,
      name: `deploy-runtime-${suffix}`,
      deployType: "image",
      imageUrl: "nginx:alpine",
      envVars: "[]",
      createdAt: now,
    })
    .execute();

  return { projectId, environmentId, serviceId };
}

async function cleanupFixture(fixture: TestFixture): Promise<void> {
  await db
    .updateTable("services")
    .set({ currentDeploymentId: null })
    .where("id", "=", fixture.serviceId)
    .execute();

  await db
    .deleteFrom("deployments")
    .where("serviceId", "=", fixture.serviceId)
    .execute();

  await db.deleteFrom("services").where("id", "=", fixture.serviceId).execute();
  await db
    .deleteFrom("environments")
    .where("id", "=", fixture.environmentId)
    .execute();
  await db.deleteFrom("projects").where("id", "=", fixture.projectId).execute();
}

describe("deployment reconciliation", function describeRuntimeStatus() {
  test("fails stale in-progress deployments", async function testStaleDeploy() {
    const fixture = await createFixture();

    try {
      const deploymentId = `dep-deploy-runtime-${nanoid(8)}`;
      await db
        .insertInto("deployments")
        .values({
          id: deploymentId,
          serviceId: fixture.serviceId,
          environmentId: fixture.environmentId,
          commitSha: "HEAD",
          status: "building",
          createdAt: Date.now() - 31 * 60 * 1000,
        })
        .execute();

      setDeploymentRuntimeDockerForTests({
        stopContainer: async function stopContainer() {},
        stopContainersByLabel: async function stopContainersByLabel() {},
      });

      const failed = await failStaleInProgressDeployments();
      expect(failed).toBeGreaterThanOrEqual(1);

      const persisted = await db
        .selectFrom("deployments")
        .select(["status", "errorMessage", "finishedAt"])
        .where("id", "=", deploymentId)
        .executeTakeFirst();

      expect(persisted?.status).toBe("failed");
      expect(persisted?.errorMessage).toBe(getDeployTimeoutError());
      expect(typeof persisted?.finishedAt).toBe("number");
    } finally {
      resetDeploymentRuntimeDockerForTests();
      await cleanupFixture(fixture);
    }
  });

  test("startup fails abandoned in-progress deployment", async function testStartupDeploy() {
    const fixture = await createFixture();
    const stoppedContainers: string[] = [];
    const stoppedLabels: string[] = [];

    try {
      const deploymentId = `dep-deploy-runtime-${nanoid(8)}`;
      const replicaId = `rep-deploy-runtime-${nanoid(8)}`;
      const now = Date.now();
      const staleCreatedAt = now - getDeployTimeoutMs() - 1000;

      await db
        .insertInto("deployments")
        .values({
          id: deploymentId,
          serviceId: fixture.serviceId,
          environmentId: fixture.environmentId,
          commitSha: "HEAD",
          status: "deploying",
          createdAt: staleCreatedAt,
        })
        .execute();

      await db
        .insertInto("deploymentLocks")
        .values({
          serviceId: fixture.serviceId,
          deploymentId,
          claimToken: "test-claim",
          claimedAt: now,
        })
        .execute();

      await db
        .insertInto("replicas")
        .values({
          id: replicaId,
          deploymentId,
          replicaIndex: 0,
          containerId: "known-container",
          hostPort: 19001,
          status: "running",
        })
        .execute();

      await db
        .updateTable("services")
        .set({ currentDeploymentId: deploymentId })
        .where("id", "=", fixture.serviceId)
        .execute();

      setDeploymentRuntimeDockerForTests({
        listFrostContainers: async function listFrostContainers() {
          return [
            {
              id: "orphan-container",
              name: "orphan-container",
              status: "running",
              labels: {
                "frost.managed": "true",
                "frost.deployment.id": deploymentId,
              },
            },
          ];
        },
        stopContainer: async function stopContainer(containerId) {
          stoppedContainers.push(containerId);
        },
        stopContainersByLabel: async function stopContainersByLabel(
          name,
          value,
        ) {
          stoppedLabels.push(`${name}=${value}`);
        },
      });

      const result = await reconcileDeploymentStartupState();

      expect(result.failedDeployments).toBeGreaterThanOrEqual(1);
      expect(result.stoppedOrphanContainers).toBeGreaterThanOrEqual(1);
      expect(stoppedLabels).toContain(`frost.deployment.id=${deploymentId}`);
      expect(stoppedContainers).toContain("known-container");
      expect(stoppedContainers).toContain("orphan-container");

      const deployment = await db
        .selectFrom("deployments")
        .select(["status", "errorMessage", "finishedAt"])
        .where("id", "=", deploymentId)
        .executeTakeFirst();

      expect(deployment?.status).toBe("failed");
      expect(deployment?.errorMessage).toBe(getDeployTimeoutError());
      expect(typeof deployment?.finishedAt).toBe("number");

      const lock = await db
        .selectFrom("deploymentLocks")
        .select("serviceId")
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirst();
      expect(lock).toBeUndefined();

      const service = await db
        .selectFrom("services")
        .select("currentDeploymentId")
        .where("id", "=", fixture.serviceId)
        .executeTakeFirst();
      expect(service?.currentDeploymentId).toBeNull();
    } finally {
      resetDeploymentRuntimeDockerForTests();
      await cleanupFixture(fixture);
    }
  });

  test("startup keeps fresh in-progress deployment containers", async function testFreshStartupDeploy() {
    const fixture = await createFixture();
    const stoppedContainers: string[] = [];
    const stoppedLabels: string[] = [];

    try {
      const deploymentId = `dep-deploy-runtime-${nanoid(8)}`;
      const now = Date.now();

      await db
        .insertInto("deployments")
        .values({
          id: deploymentId,
          serviceId: fixture.serviceId,
          environmentId: fixture.environmentId,
          commitSha: "HEAD",
          status: "deploying",
          createdAt: now,
        })
        .execute();

      setDeploymentRuntimeDockerForTests({
        listFrostContainers: async function listFrostContainers() {
          return [
            {
              id: "fresh-container",
              name: "fresh-container",
              status: "running",
              labels: {
                "frost.managed": "true",
                "frost.deployment.id": deploymentId,
              },
            },
          ];
        },
        stopContainer: async function stopContainer(containerId) {
          stoppedContainers.push(containerId);
        },
        stopContainersByLabel: async function stopContainersByLabel(
          name,
          value,
        ) {
          stoppedLabels.push(`${name}=${value}`);
        },
      });

      const result = await reconcileDeploymentStartupState();

      expect(result.failedDeployments).toBe(0);
      expect(result.stoppedOrphanContainers).toBe(0);
      expect(stoppedContainers).toEqual([]);
      expect(stoppedLabels).toEqual([]);

      const deployment = await db
        .selectFrom("deployments")
        .select(["status", "errorMessage", "finishedAt"])
        .where("id", "=", deploymentId)
        .executeTakeFirst();

      expect(deployment?.status).toBe("deploying");
      expect(deployment?.errorMessage).toBeNull();
      expect(deployment?.finishedAt).toBeNull();
    } finally {
      resetDeploymentRuntimeDockerForTests();
      await cleanupFixture(fixture);
    }
  });

  test("marks running deployments without live containers as stopped", async function testReconcileRunning() {
    const fixture = await createFixture();
    const suffix = nanoid(8);
    const liveId = `dep-live-${suffix}`;
    const exitedId = `dep-exited-${suffix}`;
    const goneId = `dep-gone-${suffix}`;
    const replicaLiveId = `dep-replica-${suffix}`;
    const liveContainer = `live${suffix}`.padEnd(64, "a");
    const exitedContainer = `exited${suffix}`.padEnd(64, "b");
    const goneContainer = `gone${suffix}`.padEnd(64, "c");
    const replicaPrimary = `primary${suffix}`.padEnd(64, "d");
    const replicaSecondary = `secondary${suffix}`.padEnd(64, "e");
    let psCalls = 0;

    try {
      const now = Date.now();
      for (const [id, containerId] of [
        [liveId, liveContainer],
        [exitedId, exitedContainer],
        [goneId, goneContainer],
        [replicaLiveId, replicaPrimary],
      ] as const) {
        await db
          .insertInto("deployments")
          .values({
            id,
            serviceId: fixture.serviceId,
            environmentId: fixture.environmentId,
            commitSha: "HEAD",
            status: "running",
            containerId,
            createdAt: now,
            finishedAt: now,
          })
          .execute();
      }
      await db
        .insertInto("replicas")
        .values([
          {
            id: `rep-a-${suffix}`,
            deploymentId: replicaLiveId,
            replicaIndex: 0,
            containerId: replicaPrimary,
            status: "running",
          },
          {
            id: `rep-b-${suffix}`,
            deploymentId: replicaLiveId,
            replicaIndex: 1,
            containerId: replicaSecondary,
            status: "running",
          },
        ])
        .execute();
      await db
        .updateTable("services")
        .set({ currentDeploymentId: goneId })
        .where("id", "=", fixture.serviceId)
        .execute();

      setDeploymentRuntimeDockerForTests({
        listManagedContainerStates: async function listStates() {
          psCalls += 1;
          return new Map([
            [liveContainer, "running"],
            [exitedContainer, "exited"],
            [replicaPrimary, "exited"],
            [replicaSecondary, "running"],
          ]);
        },
      });

      await reconcileRunningDeployments();
      expect(psCalls).toBe(1);

      const rows = await db
        .selectFrom("deployments")
        .select(["id", "status"])
        .where("serviceId", "=", fixture.serviceId)
        .execute();
      const statusById = Object.fromEntries(
        rows.map(function toEntry(row) {
          return [row.id, row.status];
        }),
      );
      expect(statusById[liveId]).toBe("running");
      expect(statusById[replicaLiveId]).toBe("running");
      expect(statusById[exitedId]).toBe("stopped");
      expect(statusById[goneId]).toBe("stopped");

      const service = await db
        .selectFrom("services")
        .select("currentDeploymentId")
        .where("id", "=", fixture.serviceId)
        .executeTakeFirst();
      expect(service?.currentDeploymentId).toBeNull();
    } finally {
      resetDeploymentRuntimeDockerForTests();
      await db
        .deleteFrom("replicas")
        .where("deploymentId", "=", replicaLiveId)
        .execute();
      await cleanupFixture(fixture);
    }
  });

  test("leaves a sleeping service's stopped deployment running", async function testSleepingService() {
    const fixture = await createFixture();
    const suffix = nanoid(8);
    const sleepingId = `dep-sleeping-${suffix}`;
    const sleepingContainer = `sleeping${suffix}`.padEnd(64, "f");

    try {
      const now = Date.now();
      await db
        .insertInto("deployments")
        .values({
          id: sleepingId,
          serviceId: fixture.serviceId,
          environmentId: fixture.environmentId,
          commitSha: "HEAD",
          status: "running",
          containerId: sleepingContainer,
          createdAt: now,
          finishedAt: now,
        })
        .execute();
      await db
        .updateTable("services")
        .set({ currentDeploymentId: sleepingId, sleepingSince: now })
        .where("id", "=", fixture.serviceId)
        .execute();

      setDeploymentRuntimeDockerForTests({
        listManagedContainerStates: async function listStates() {
          return new Map([[sleepingContainer, "exited"]]);
        },
      });

      await reconcileRunningDeployments();

      const deployment = await db
        .selectFrom("deployments")
        .select("status")
        .where("id", "=", sleepingId)
        .executeTakeFirst();
      expect(deployment?.status).toBe("running");

      // Once awake again, a dead container is reconciled as usual.
      await db
        .updateTable("services")
        .set({ sleepingSince: null })
        .where("id", "=", fixture.serviceId)
        .execute();
      await reconcileRunningDeployments();
      const after = await db
        .selectFrom("deployments")
        .select("status")
        .where("id", "=", sleepingId)
        .executeTakeFirst();
      expect(after?.status).toBe("stopped");
    } finally {
      resetDeploymentRuntimeDockerForTests();
      await cleanupFixture(fixture);
    }
  });

  test("skips running reconciliation when docker is unavailable", async function testDockerUnavailable() {
    const fixture = await createFixture();

    try {
      const deploymentId = `dep-nodocker-${nanoid(8)}`;
      await db
        .insertInto("deployments")
        .values({
          id: deploymentId,
          serviceId: fixture.serviceId,
          environmentId: fixture.environmentId,
          commitSha: "HEAD",
          status: "running",
          containerId: "some-container-id",
          createdAt: Date.now(),
        })
        .execute();

      setDeploymentRuntimeDockerForTests({
        listManagedContainerStates: async function listStates() {
          return null;
        },
      });

      expect(await reconcileRunningDeployments()).toBe(0);

      const row = await db
        .selectFrom("deployments")
        .select("status")
        .where("id", "=", deploymentId)
        .executeTakeFirst();
      expect(row?.status).toBe("running");
    } finally {
      resetDeploymentRuntimeDockerForTests();
      await cleanupFixture(fixture);
    }
  });
});

describe("findContainerState", function describeFindContainerState() {
  const fullId = "a".repeat(12) + "b".repeat(52);
  const states = new Map([[fullId, "running"]]);

  test("matches full ids", function testFull() {
    expect(findContainerState(states, fullId)).toBe("running");
  });

  test("matches short ids by prefix", function testShort() {
    expect(findContainerState(states, fullId.slice(0, 12))).toBe("running");
  });

  test("returns null for missing or too-short ids", function testMissing() {
    expect(findContainerState(states, "c".repeat(64))).toBeNull();
    expect(findContainerState(states, "aaaa")).toBeNull();
  });
});
