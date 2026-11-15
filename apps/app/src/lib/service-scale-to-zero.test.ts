import { afterEach, describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { setSetting } from "./auth";
import { db } from "./db";
import { computeDesiredCaddyConfig } from "./domains";
import {
  getServiceWakePort,
  SERVICE_WAKE_HEADER,
} from "./scale-to-zero-config";
import {
  ensureServiceAwake,
  isServiceIdleDue,
  listSleepingContainerIds,
  resetScaleToZeroStateForTests,
  runScaleToZeroTick,
  ServiceWakeError,
  setScaleToZeroDepsForTests,
  sleepService,
  trackProxyConnection,
} from "./service-scale-to-zero";

const MINUTE = 60_000;

interface Fixture {
  projectId: string;
  environmentId: string;
  serviceId: string;
  deploymentId: string;
  domain: string;
  containers: Array<{ containerId: string; hostPort: number }>;
}

async function createFixture(input: {
  scaleToZeroMinutes: number | null;
  liveSince: number;
  replicaCount?: number;
}): Promise<Fixture> {
  const suffix = nanoid(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x");
  const projectId = `proj-stz-${suffix}`;
  const environmentId = `env-stz-${suffix}`;
  const serviceId = `svc-stz-${suffix}`;
  const deploymentId = `dep-stz-${suffix}`;
  const domain = `stz-${suffix}.example.com`;
  const replicaCount = input.replicaCount ?? 2;
  const basePort = 15000 + Math.floor(Math.random() * 4000);
  const containers = Array.from({ length: replicaCount }, (_, i) => ({
    containerId: `c${i}${suffix}`.padEnd(64, "0"),
    hostPort: basePort + i,
  }));

  await db
    .insertInto("projects")
    .values({ id: projectId, name: projectId, envVars: "[]", createdAt: 1 })
    .execute();
  await db
    .insertInto("environments")
    .values({
      id: environmentId,
      projectId,
      name: "production",
      type: "production",
      isEphemeral: false,
      createdAt: 1,
    })
    .execute();
  await db
    .insertInto("services")
    .values({
      id: serviceId,
      environmentId,
      name: serviceId,
      deployType: "image",
      imageUrl: "nginx:alpine",
      envVars: "[]",
      createdAt: 1,
    })
    .execute();
  await db
    .insertInto("deployments")
    .values({
      id: deploymentId,
      serviceId,
      environmentId,
      commitSha: "HEAD",
      status: "running",
      containerId: containers[0].containerId,
      hostPort: containers[0].hostPort,
      healthCheckPath: "/health",
      healthCheckTimeout: 5,
      scaleToZeroMinutes: input.scaleToZeroMinutes,
      createdAt: input.liveSince,
      finishedAt: input.liveSince,
    })
    .execute();
  await db
    .insertInto("replicas")
    .values(
      containers.map((container, index) => ({
        id: `rep-${index}-${suffix}`,
        deploymentId,
        replicaIndex: index,
        containerId: container.containerId,
        hostPort: container.hostPort,
        status: "running",
      })),
    )
    .execute();
  await db
    .updateTable("services")
    .set({ currentDeploymentId: deploymentId })
    .where("id", "=", serviceId)
    .execute();
  await db
    .insertInto("domains")
    .values({
      id: `dom-stz-${suffix}`,
      serviceId,
      environmentId,
      domain,
      type: "proxy",
      dnsVerified: true,
      createdAt: 1,
    })
    .execute();

  return {
    projectId,
    environmentId,
    serviceId,
    deploymentId,
    domain,
    containers,
  };
}

async function getService(serviceId: string) {
  const service = await db
    .selectFrom("services")
    .select(["sleepingSince", "lastActivityAt"])
    .where("id", "=", serviceId)
    .executeTakeFirst();
  if (!service) throw new Error("service missing");
  return service;
}

interface FakeDocker {
  started: string[];
  stopped: Array<{ containerId: string; timeout: number }>;
  syncs: number;
  bytes: Map<string, number>;
  healthy: boolean;
  syncError: Error | null;
}

function installFakes(now: () => number): FakeDocker {
  const fake: FakeDocker = {
    started: [],
    stopped: [],
    syncs: 0,
    bytes: new Map(),
    healthy: true,
    syncError: null,
  };
  setScaleToZeroDepsForTests({
    getNow: now,
    getContainerNetworkBytes: async (containerId) =>
      fake.bytes.get(containerId) ?? 1000,
    startContainer: async (containerId) => {
      fake.started.push(containerId);
    },
    stopContainer: async (containerId, timeout) => {
      fake.stopped.push({ containerId, timeout });
    },
    waitForHealthy: async () => fake.healthy,
    syncCaddyConfig: async () => {
      fake.syncs += 1;
      if (fake.syncError) throw fake.syncError;
      return { synced: true };
    },
  });
  return fake;
}

const fixtures: Fixture[] = [];

async function fixture(
  input: Parameters<typeof createFixture>[0],
): Promise<Fixture> {
  const created = await createFixture(input);
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  resetScaleToZeroStateForTests();
  for (const f of fixtures.splice(0)) {
    await db
      .deleteFrom("domains")
      .where("serviceId", "=", f.serviceId)
      .execute();
    await db
      .updateTable("services")
      .set({ currentDeploymentId: null })
      .where("id", "=", f.serviceId)
      .execute();
    await db
      .deleteFrom("replicas")
      .where("deploymentId", "=", f.deploymentId)
      .execute();
    await db
      .deleteFrom("deployments")
      .where("id", "=", f.deploymentId)
      .execute();
    await db.deleteFrom("services").where("id", "=", f.serviceId).execute();
    await db
      .deleteFrom("environments")
      .where("id", "=", f.environmentId)
      .execute();
    await db.deleteFrom("projects").where("id", "=", f.projectId).execute();
  }
});

describe("isServiceIdleDue", () => {
  test("counts idle time from the later of last activity and go-live", () => {
    const now = 100 * MINUTE;
    expect(
      isServiceIdleDue({
        lastActivityAt: null,
        liveSince: now - 5 * MINUTE,
        scaleToZeroMinutes: 5,
        now,
      }),
    ).toBe(true);
    expect(
      isServiceIdleDue({
        lastActivityAt: now - 4 * MINUTE,
        liveSince: now - 60 * MINUTE,
        scaleToZeroMinutes: 5,
        now,
      }),
    ).toBe(false);
    // Activity recorded before a newer deploy went live doesn't count.
    expect(
      isServiceIdleDue({
        lastActivityAt: now - 60 * MINUTE,
        liveSince: now - MINUTE,
        scaleToZeroMinutes: 5,
        now,
      }),
    ).toBe(false);
  });
});

describe("scale-to-zero lifecycle", () => {
  test("sleeps an idle service, then wakes it once for concurrent requests", async () => {
    const now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: 1,
      liveSince: now - 2 * MINUTE,
    });
    const fake = installFakes(() => now);

    // First pass only records a traffic baseline.
    expect((await runScaleToZeroTick()).slept).not.toContain(f.serviceId);
    expect(fake.stopped).toHaveLength(0);

    expect((await runScaleToZeroTick()).slept).toContain(f.serviceId);
    expect((await getService(f.serviceId)).sleepingSince).toBe(now);
    expect(fake.syncs).toBe(1);
    expect(fake.stopped).toEqual(
      f.containers.map((c) => ({ containerId: c.containerId, timeout: 30 })),
    );
    expect(await listSleepingContainerIds()).toEqual(
      expect.arrayContaining(f.containers.map((c) => c.containerId)),
    );

    // Three requests arrive while asleep: one wake, all get the ports.
    const results = await Promise.all([
      ensureServiceAwake(f.serviceId),
      ensureServiceAwake(f.serviceId),
      ensureServiceAwake(f.serviceId),
    ]);
    const ports = f.containers.map((c) => c.hostPort);
    expect(results).toEqual([ports, ports, ports]);
    expect(fake.started).toEqual(f.containers.map((c) => c.containerId));
    expect(fake.syncs).toBe(2);

    const awake = await getService(f.serviceId);
    expect(awake.sleepingSince).toBeNull();
    expect(awake.lastActivityAt).toBe(now);
    expect(await listSleepingContainerIds()).not.toContain(
      f.containers[0].containerId,
    );
  });

  test("records network activity instead of sleeping", async () => {
    let now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: 1,
      liveSince: now - 5 * MINUTE,
    });
    const fake = installFakes(() => now);

    await runScaleToZeroTick();
    fake.bytes.set(f.containers[1].containerId, 5000);
    now += 1000;
    expect((await runScaleToZeroTick()).slept).not.toContain(f.serviceId);
    const service = await getService(f.serviceId);
    expect(service.lastActivityAt).toBe(now);
    expect(service.sleepingSince).toBeNull();

    // Quiet for less than the threshold: still awake.
    now += 30_000;
    expect((await runScaleToZeroTick()).slept).not.toContain(f.serviceId);
    // Quiet for the full minute: asleep.
    now += 31_000;
    expect((await runScaleToZeroTick()).slept).toContain(f.serviceId);
  });

  test("never sleeps while the wake server proxies a connection", async () => {
    const now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: 1,
      liveSince: now - 5 * MINUTE,
    });
    installFakes(() => now);

    const release = trackProxyConnection(f.serviceId);
    await runScaleToZeroTick();
    expect((await runScaleToZeroTick()).slept).not.toContain(f.serviceId);
    release();
    expect((await runScaleToZeroTick()).slept).toContain(f.serviceId);
  });

  test("ignores services without scale-to-zero, but force-sleep works", async () => {
    const now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: null,
      liveSince: now - 60 * MINUTE,
      replicaCount: 1,
    });
    const fake = installFakes(() => now);

    await runScaleToZeroTick();
    expect((await runScaleToZeroTick()).slept).not.toContain(f.serviceId);
    expect(await sleepService(f.serviceId)).toBe(false);
    expect(await sleepService(f.serviceId, { force: true })).toBe(true);
    expect(fake.stopped).toHaveLength(1);
    // Already asleep.
    expect(await sleepService(f.serviceId, { force: true })).toBe(false);
  });

  test("stays awake when routing traffic to the wake server fails", async () => {
    const now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: 1,
      liveSince: now - 5 * MINUTE,
    });
    const fake = installFakes(() => now);
    fake.syncError = new Error("caddy down");

    await expect(sleepService(f.serviceId, { force: true })).rejects.toThrow(
      "caddy down",
    );
    expect((await getService(f.serviceId)).sleepingSince).toBeNull();
    expect(fake.stopped).toHaveLength(0);
  });

  test("a failed health check leaves the service asleep for the next try", async () => {
    const now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: 1,
      liveSince: now - 5 * MINUTE,
    });
    const fake = installFakes(() => now);
    await sleepService(f.serviceId, { force: true });

    fake.healthy = false;
    fake.stopped = [];
    await expect(ensureServiceAwake(f.serviceId)).rejects.toBeInstanceOf(
      ServiceWakeError,
    );
    expect((await getService(f.serviceId)).sleepingSince).toBe(now);
    // Containers that started are stopped again, not left running.
    expect(fake.stopped.map((s) => s.containerId)).toEqual(
      f.containers.map((c) => c.containerId),
    );

    fake.healthy = true;
    await ensureServiceAwake(f.serviceId);
    expect((await getService(f.serviceId)).sleepingSince).toBeNull();
  });

  test("routes a sleeping service's domain to the wake server in Caddy", async () => {
    const now = Date.now();
    const f = await fixture({
      scaleToZeroMinutes: 1,
      liveSince: now - 5 * MINUTE,
    });
    installFakes(() => now);
    await setSetting("email", "ops@example.com");

    try {
      const findRoute = async () => {
        const desired = await computeDesiredCaddyConfig();
        const json = JSON.stringify(desired.config);
        const config = JSON.parse(json) as {
          apps: {
            http: {
              servers: Record<
                string,
                {
                  routes: Array<{
                    match: Array<{ host: string[] }>;
                    handle: Array<Record<string, unknown>>;
                  }>;
                }
              >;
            };
          };
        };
        for (const server of Object.values(config.apps.http.servers)) {
          for (const route of server.routes) {
            if (route.match?.[0]?.host?.includes(f.domain)) {
              return route.handle[0];
            }
          }
        }
        throw new Error("route not found");
      };

      const awakeRoute = await findRoute();
      expect(awakeRoute.upstreams).toEqual(
        f.containers.map((c) => ({ dial: `127.0.0.1:${c.hostPort}` })),
      );
      expect(awakeRoute.headers).toBeUndefined();

      await sleepService(f.serviceId, { force: true });
      const sleepingRoute = await findRoute();
      expect(sleepingRoute.upstreams).toEqual([
        { dial: `127.0.0.1:${getServiceWakePort()}` },
      ]);
      expect(sleepingRoute.headers).toEqual({
        request: { set: { [SERVICE_WAKE_HEADER]: [f.serviceId] } },
      });
    } finally {
      await db.deleteFrom("settings").where("key", "=", "email").execute();
    }
  });
});
