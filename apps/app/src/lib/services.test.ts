import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_SSL_PATH = join(tmpdir(), "frost-services-test-ssl");
process.env.FROST_SSL_PATH = TEST_SSL_PATH;

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { db } from "./db";
import { createService } from "./services";
import { sslCertsExist } from "./ssl";

const TEST_PROJECT_ID = `test-svc-${nanoid(8)}`;
const TEST_ENV_ID = `test-svc-${nanoid(8)}`;

describe("createService", () => {
  beforeAll(async () => {
    if (existsSync(TEST_SSL_PATH)) {
      rmSync(TEST_SSL_PATH, { recursive: true, force: true });
    }
    mkdirSync(TEST_SSL_PATH, { recursive: true });

    const now = Date.now();
    await db
      .insertInto("projects")
      .values({
        id: TEST_PROJECT_ID,
        name: "services-test",
        hostname: "services-test",
        envVars: "[]",
        createdAt: now,
      })
      .execute();

    await db
      .insertInto("environments")
      .values({
        id: TEST_ENV_ID,
        projectId: TEST_PROJECT_ID,
        name: "production",
        type: "production",
        isEphemeral: false,
        createdAt: now,
      })
      .execute();
  });

  afterAll(async () => {
    await db
      .deleteFrom("domains")
      .where(
        "serviceId",
        "in",
        db
          .selectFrom("services")
          .select("id")
          .where("environmentId", "=", TEST_ENV_ID),
      )
      .execute();
    await db
      .deleteFrom("services")
      .where("environmentId", "=", TEST_ENV_ID)
      .execute();
    await db.deleteFrom("environments").where("id", "=", TEST_ENV_ID).execute();
    await db.deleteFrom("projects").where("id", "=", TEST_PROJECT_ID).execute();

    if (existsSync(TEST_SSL_PATH)) {
      rmSync(TEST_SSL_PATH, { recursive: true, force: true });
    }
  });

  test("turns scale to zero on by default for apps only", async () => {
    const app = await createService({
      environmentId: TEST_ENV_ID,
      name: "stz-default",
      hostname: "stz-default",
      deployType: "image",
      imageUrl: "nginx:alpine",
    });
    expect(app.scaleToZeroMinutes).toBe(15);

    const alwaysOn = await createService({
      environmentId: TEST_ENV_ID,
      name: "stz-always-on",
      hostname: "stz-always-on",
      deployType: "image",
      imageUrl: "nginx:alpine",
      scaleToZeroMinutes: null,
    });
    expect(alwaysOn.scaleToZeroMinutes).toBeNull();

    const database = await createService({
      environmentId: TEST_ENV_ID,
      name: "stz-db",
      hostname: "stz-db",
      deployType: "image",
      serviceType: "database",
      imageUrl: "postgres:17",
    });
    expect(database.scaleToZeroMinutes).toBeNull();
  });

  test("creates service with basic fields", async () => {
    const service = await createService({
      environmentId: TEST_ENV_ID,
      name: "basic-service",
      hostname: "basic-svc",
      deployType: "image",
      imageUrl: "nginx:alpine",
      containerPort: 80,
    });

    expect(service.id).toBeDefined();
    expect(service.name).toBe("basic-service");
    expect(service.hostname).toBe("basic-svc");
    expect(service.deployType).toBe("image");
    expect(service.imageUrl).toBe("nginx:alpine");
    expect(service.containerPort).toBe(80);
    expect(service.serviceType).toBe("app");
    expect(service.autoDeploy).toBeFalsy();

    const fromDb = await db
      .selectFrom("services")
      .selectAll()
      .where("id", "=", service.id)
      .executeTakeFirst();

    expect(fromDb).toBeDefined();
    expect(fromDb?.name).toBe("basic-service");
  });

  test("creates repo service with all fields", async () => {
    const service = await createService({
      environmentId: TEST_ENV_ID,
      name: "repo-service",
      hostname: "repo-svc",
      deployType: "repo",
      repoUrl: "https://github.com/example/repo.git",
      branch: "main",
      dockerfilePath: "Dockerfile",
      buildContext: ".",
      envVars: [
        { key: "NODE_ENV", value: "production" },
        { key: "PORT", value: "3000" },
      ],
      containerPort: 3000,
      healthCheckPath: "/health",
      healthCheckTimeout: 30,
      memoryLimit: "512m",
      cpuLimit: 1,
      shutdownTimeout: 10,
      autoDeploy: true,
    });

    expect(service.deployType).toBe("repo");
    expect(service.repoUrl).toBe("https://github.com/example/repo.git");
    expect(service.branch).toBe("main");
    expect(service.dockerfilePath).toBe("Dockerfile");
    expect(service.buildContext).toBe(".");
    expect(service.healthCheckPath).toBe("/health");
    expect(service.healthCheckTimeout).toBe(30);
    expect(service.memoryLimit).toBe("512m");
    expect(service.cpuLimit).toBe(1);
    expect(service.shutdownTimeout).toBe(10);
    expect(service.autoDeploy).toBeTruthy();

    const envVars = JSON.parse(service.envVars);
    expect(envVars).toHaveLength(2);
    expect(envVars[0].key).toBe("NODE_ENV");
  });

  test("creates database service with SSL cert", async () => {
    const service = await createService({
      environmentId: TEST_ENV_ID,
      name: "postgres-db",
      hostname: "postgres",
      deployType: "image",
      serviceType: "database",
      imageUrl: "postgres:17",
      containerPort: 5432,
      ssl: true,
    });

    expect(service.serviceType).toBe("database");
    expect(sslCertsExist(service.id)).toBe(true);
  });

  test("defaults empty envVars and volumes", async () => {
    const service = await createService({
      environmentId: TEST_ENV_ID,
      name: "defaults-service",
      hostname: "defaults-svc",
      deployType: "image",
      imageUrl: "nginx:alpine",
    });

    expect(JSON.parse(service.envVars)).toEqual([]);
    expect(JSON.parse(service.volumes ?? "[]")).toEqual([]);
  });
});
