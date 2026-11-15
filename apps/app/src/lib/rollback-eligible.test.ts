import { describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { resetInterruptedCleanup } from "./cleanup";
import { db } from "./db";
import { updateRollbackEligible } from "./deployer";
import { parseBuildCachePruneBytes } from "./docker";

async function createService(volumes = "[]"): Promise<string> {
  const suffix = nanoid(8);
  const projectId = `proj-rb-${suffix}`;
  const environmentId = `env-rb-${suffix}`;
  const serviceId = `svc-rb-${suffix}`;
  const now = Date.now();
  await db
    .insertInto("projects")
    .values({
      id: projectId,
      name: `rb-${suffix}`,
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
      name: `rb-${suffix}`,
      deployType: "image",
      imageUrl: "nginx:alpine",
      envVars: "[]",
      volumes,
      createdAt: now,
    })
    .execute();
  return serviceId;
}

async function addDeployment(
  serviceId: string,
  status: "running" | "stopped" | "failed",
  createdAt: number,
): Promise<string> {
  const id = `dep-rb-${nanoid(10)}`;
  const service = await db
    .selectFrom("services")
    .select("environmentId")
    .where("id", "=", serviceId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("deployments")
    .values({
      id,
      serviceId,
      environmentId: service.environmentId,
      commitSha: "abc1234",
      status,
      imageName: `frost-${serviceId}:${id}`,
      rollbackEligible: true,
      createdAt,
    })
    .execute();
  return id;
}

async function eligibleIds(serviceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("deployments")
    .select("id")
    .where("serviceId", "=", serviceId)
    .where("rollbackEligible", "=", true)
    .execute();
  return rows.map((row) => row.id).sort();
}

describe("updateRollbackEligible", () => {
  test("keeps only the latest 5 successful deployments, incl. stopped ones", async () => {
    const serviceId = await createService();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(await addDeployment(serviceId, "stopped", 1_000 + i));
    }
    const failed = await addDeployment(serviceId, "failed", 2_000);
    const running = await addDeployment(serviceId, "running", 3_000);

    await updateRollbackEligible(serviceId);

    // newest successful: running + the 4 newest stopped
    expect(await eligibleIds(serviceId)).toEqual(
      [running, ...ids.slice(4)].sort(),
    );
    expect(await eligibleIds(serviceId)).not.toContain(failed);
  });

  test("clears all flags for services with volumes", async () => {
    const serviceId = await createService('[{"name":"data","path":"/data"}]');
    await addDeployment(serviceId, "stopped", 1_000);
    await addDeployment(serviceId, "running", 2_000);

    await updateRollbackEligible(serviceId);

    expect(await eligibleIds(serviceId)).toEqual([]);
  });
});

describe("parseBuildCachePruneBytes", () => {
  test("parses old and new docker output formats", () => {
    expect(parseBuildCachePruneBytes("Total reclaimed space: 1.5GB")).toBe(
      Math.round(1.5 * 1024 ** 3),
    );
    expect(parseBuildCachePruneBytes("ID ...\nTotal:  6.815GB\n")).toBe(
      Math.round(6.815 * 1024 ** 3),
    );
    expect(parseBuildCachePruneBytes("Total:\t898.1MB")).toBe(
      Math.round(898.1 * 1024 ** 2),
    );
    expect(parseBuildCachePruneBytes("nothing to prune")).toBe(0);
  });
});

describe("resetInterruptedCleanup", () => {
  test("clears a running lock and is a no-op otherwise", async () => {
    await db
      .insertInto("settings")
      .values({ key: "cleanup_running", value: "true" })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: "true" }))
      .execute();

    expect(await resetInterruptedCleanup()).toBe(true);
    expect(await resetInterruptedCleanup()).toBe(false);

    const row = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", "cleanup_running")
      .executeTakeFirstOrThrow();
    expect(row.value).toBe("false");
  });
});
