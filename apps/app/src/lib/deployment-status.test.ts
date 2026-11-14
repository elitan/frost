import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { db } from "./db";
import {
  IN_PROGRESS_DEPLOYMENT_STATUSES,
  transitionDeploymentStatus,
} from "./deployment-status";
import { runMigrations } from "./migrate";

runMigrations();

const suffix = nanoid(8);
const projectId = `proj-deploy-status-${suffix}`;
const environmentId = `env-deploy-status-${suffix}`;
const serviceId = `svc-deploy-status-${suffix}`;

beforeAll(async function setup() {
  const now = Date.now();
  await db
    .insertInto("projects")
    .values({
      id: projectId,
      name: `deploy-status-${suffix}`,
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
      name: `deploy-status-${suffix}`,
      deployType: "image",
      imageUrl: "nginx:alpine",
      envVars: "[]",
      createdAt: now,
    })
    .execute();
});

afterAll(async function cleanup() {
  await db
    .deleteFrom("deployments")
    .where("serviceId", "=", serviceId)
    .execute();
  await db.deleteFrom("services").where("id", "=", serviceId).execute();
  await db.deleteFrom("environments").where("id", "=", environmentId).execute();
  await db.deleteFrom("projects").where("id", "=", projectId).execute();
});

async function insertDeployment(
  status: "building" | "running" | "cancelled",
  containerId: string | null = null,
): Promise<string> {
  const id = `dep-deploy-status-${nanoid(8)}`;
  await db
    .insertInto("deployments")
    .values({
      id,
      serviceId,
      environmentId,
      commitSha: "HEAD",
      status,
      containerId,
      createdAt: Date.now(),
    })
    .execute();
  return id;
}

async function getDeployment(id: string) {
  return db
    .selectFrom("deployments")
    .select(["status", "errorMessage", "finishedAt"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

describe("transitionDeploymentStatus", function describeTransition() {
  test("applies when current status is allowed", async function testApplies() {
    const id = await insertDeployment("building");

    const applied = await transitionDeploymentStatus(
      id,
      IN_PROGRESS_DEPLOYMENT_STATUSES,
      "failed",
      { errorMessage: "boom", finishedAt: 123 },
    );

    expect(applied).toBe(true);
    expect(await getDeployment(id)).toEqual({
      status: "failed",
      errorMessage: "boom",
      finishedAt: 123,
    });
  });

  test("does not overwrite a status outside fromStatuses", async function testRejects() {
    const id = await insertDeployment("cancelled");

    const applied = await transitionDeploymentStatus(
      id,
      IN_PROGRESS_DEPLOYMENT_STATUSES,
      "deploying",
      { errorMessage: "should not be written" },
    );

    expect(applied).toBe(false);
    expect(await getDeployment(id)).toEqual({
      status: "cancelled",
      errorMessage: null,
      finishedAt: null,
    });
  });

  test("returns false for unknown deployments and empty fromStatuses", async function testNoop() {
    expect(
      await transitionDeploymentStatus("dep-missing", ["running"], "stopped"),
    ).toBe(false);

    const id = await insertDeployment("running");
    expect(await transitionDeploymentStatus(id, [], "stopped")).toBe(false);
    expect((await getDeployment(id)).status).toBe("running");
  });

  test("honours expectedContainerId", async function testContainerGuard() {
    const id = await insertDeployment("running", "container-new");

    expect(
      await transitionDeploymentStatus(
        id,
        ["running"],
        "stopped",
        {},
        {
          expectedContainerId: "container-old",
        },
      ),
    ).toBe(false);
    expect((await getDeployment(id)).status).toBe("running");

    expect(
      await transitionDeploymentStatus(
        id,
        ["running"],
        "stopped",
        {},
        {
          expectedContainerId: "container-new",
        },
      ),
    ).toBe(true);
    expect((await getDeployment(id)).status).toBe("stopped");
  });

  test("only one of two concurrent transitions wins", async function testConcurrent() {
    const id = await insertDeployment("building");

    const results = await Promise.all([
      transitionDeploymentStatus(id, IN_PROGRESS_DEPLOYMENT_STATUSES, "failed"),
      transitionDeploymentStatus(
        id,
        IN_PROGRESS_DEPLOYMENT_STATUSES,
        "cancelled",
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("works inside a transaction", async function testTransaction() {
    const id = await insertDeployment("running");

    await db.transaction().execute(async function inTrx(trx) {
      const applied = await transitionDeploymentStatus(
        id,
        ["running"],
        "stopped",
        { finishedAt: 7 },
        { executor: trx },
      );
      expect(applied).toBe(true);
    });

    expect(await getDeployment(id)).toMatchObject({
      status: "stopped",
      finishedAt: 7,
    });
  });
});
