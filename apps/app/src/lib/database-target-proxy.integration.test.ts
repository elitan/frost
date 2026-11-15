import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { promisify } from "node:util";
import {
  createDatabase,
  createDatabaseTarget,
  deleteDatabase,
  getDatabaseTargetConnectionInfo,
  patchDatabaseTargetRuntimeSettings,
  sleepIdleDatabaseTargetUnlocked,
  stopDatabaseTarget,
  wakeDatabaseTargetForProxy,
  withDatabaseTargetLock,
} from "./database-runtime";
import {
  getDatabaseProxyContainerName,
  readContainerNetworkAliases,
} from "./database-target-proxy";
import { db } from "./db";
import { createActivatorControlServer } from "./service-activator";

/**
 * EXPERIMENT: scale-to-zero Postgres behind the resident proxy, against real
 * Docker. Needs the activator image (apps/activator/build.sh); skipped
 * otherwise. Takes a few minutes: one check waits out a real idle minute.
 */

const execFileAsync = promisify(execFile);
const IMAGE = process.env.FROST_ACTIVATOR_IMAGE || "frost-activator:dev";
const hasImage = await execFileAsync("docker", ["image", "inspect", IMAGE])
  .then(() => true)
  .catch(() => false);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function containerState(name: string): Promise<string | null> {
  return docker("inspect", "-f", "{{.State.Status}}", name).catch(() => null);
}

describe.skipIf(!hasImage)("database target proxy (docker)", () => {
  let server: Server;
  // Short ids keep the network name under Docker's 63-character cap.
  const projectId = `proj-${randomUUID().slice(0, 8)}`;
  const environmentId = `env-${randomUUID().slice(0, 8)}`;
  const network = `frost-net-${projectId}-${environmentId}`;
  let databaseId = "";
  let mainTargetId = "";
  let password = "";
  let username = "";
  let databaseName = "";
  const sessions: string[] = [];

  function psql(host: string, sql: string): Promise<string> {
    return docker(
      "run",
      "--rm",
      "--network",
      network,
      "-e",
      `PGPASSWORD=${password}`,
      "-e",
      "PGCONNECT_TIMEOUT=90",
      "postgres:17-alpine",
      "psql",
      `host=${host} user=${username} dbname=${databaseName} sslmode=require`,
      "-X",
      "-tAc",
      sql,
    );
  }

  /** A long-lived psql session we can feed statements to, like a pool. */
  async function openSession(host: string): Promise<{
    send: (sql: string) => Promise<void>;
    output: () => Promise<string>;
  }> {
    const name = `frost-test-session-${randomUUID().slice(0, 8)}`;
    sessions.push(name);
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      network,
      "-e",
      `PGPASSWORD=${password}`,
      "postgres:17-alpine",
      "sh",
      "-c",
      `mkfifo /in && (sleep 3600 > /in &) && psql "host=${host} user=${username} dbname=${databaseName} sslmode=require" -X -tA < /in > /out 2>&1`,
    );
    const session = {
      send: (sql: string) =>
        docker(
          "exec",
          name,
          "sh",
          "-c",
          `echo ${JSON.stringify(sql)} > /in`,
        ).then(() => {}),
      output: () => docker("exec", name, "cat", "/out").catch(() => ""),
    };
    return session;
  }

  async function targetStatus(targetId: string): Promise<string> {
    const row = await db
      .selectFrom("databaseTargets")
      .select("lifecycleStatus")
      .where("id", "=", targetId)
      .executeTakeFirstOrThrow();
    return row.lifecycleStatus;
  }

  beforeAll(async () => {
    server = createActivatorControlServer({
      ensureServiceAwake: async () => [],
      wakeDatabaseTarget: wakeDatabaseTargetForProxy,
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "0.0.0.0", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    process.env.FROST_ACTIVATOR_PORT = String(port);

    const now = Date.now();
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        name: `proxy-${projectId.slice(0, 8)}`,
        hostname: null,
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
        createdAt: now,
      })
      .execute();
    const created = await createDatabase({
      projectId,
      name: "pdb",
      engine: "postgres",
    });
    databaseId = created.database.id;
    mainTargetId = created.target.id;
    const info = await getDatabaseTargetConnectionInfo({
      databaseId,
      targetId: mainTargetId,
    });
    password = info.password;
    username = info.username;
    databaseName = info.database;
  }, 180_000);

  afterAll(async () => {
    for (const name of sessions) {
      await docker("rm", "-f", name).catch(() => {});
    }
    if (databaseId) {
      await deleteDatabase(databaseId).catch(() => {});
      expect(
        await containerState(getDatabaseProxyContainerName(mainTargetId)),
      ).toBeNull();
    }
    await docker("network", "rm", network).catch(() => {});
    await db.deleteFrom("projects").where("id", "=", projectId).execute();
    await new Promise((resolve) => server.close(resolve));
  }, 180_000);

  test("main can scale to zero; the proxy takes over its hostnames", async () => {
    // Without scale-to-zero the database owns its hostnames.
    expect(await psql("pdb.frost.internal", "select 1")).toBe("1");

    await patchDatabaseTargetRuntimeSettings({
      targetId: mainTargetId,
      scaleToZeroMinutes: 1,
    });
    const proxy = getDatabaseProxyContainerName(mainTargetId);
    expect(await containerState(proxy)).toBe("running");
    const proxyNetworks = await readContainerNetworkAliases(proxy);
    expect(proxyNetworks?.aliases.get(network)?.sort()).toEqual(
      [
        "pdb",
        "pdb.frost.internal",
        "pdb-main",
        "pdb-main.frost.internal",
      ].sort(),
    );
    const info = await getDatabaseTargetConnectionInfo({
      databaseId,
      targetId: mainTargetId,
    });
    const dbContainer = (
      await db
        .selectFrom("databaseTargets")
        .select("providerRefJson")
        .where("id", "=", mainTargetId)
        .executeTakeFirstOrThrow()
    ).providerRefJson;
    const containerName = (JSON.parse(dbContainer) as { containerName: string })
      .containerName;
    expect(
      (await readContainerNetworkAliases(containerName))?.aliases.get(network),
    ).toEqual([]);

    // TLS end to end through the proxy, on every alias.
    expect(
      await psql(
        info.internalHost,
        "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
      ),
    ).toBe("t");
    expect(await psql("pdb.frost.internal", "select 2")).toBe("2");
  }, 240_000);

  test("an open transaction keeps it awake", async () => {
    const session = await openSession("pdb.frost.internal");
    await session.send("begin; select 'in-txn';");
    await Bun.sleep(1500);
    const slept = await withDatabaseTargetLock(mainTargetId, () =>
      sleepIdleDatabaseTargetUnlocked({ databaseId, targetId: mainTargetId }),
    );
    expect(slept).toBe(false);
    expect(await targetStatus(mainTargetId)).toBe("active");
    await session.send("commit; select 'after-commit';");
    await Bun.sleep(500);
    expect(await session.output()).toContain("after-commit");
  }, 60_000);

  test("sleeps under an idle pooled connection, and the next connection wakes it", async () => {
    const session = await openSession("pdb.frost.internal");
    await session.send("select 'warm';");
    // Recent activity keeps it awake.
    expect(
      await withDatabaseTargetLock(mainTargetId, () =>
        sleepIdleDatabaseTargetUnlocked({ databaseId, targetId: mainTargetId }),
      ),
    ).toBe(false);

    // A real idle minute (the shortest setting), with the session left open.
    await Bun.sleep(62_000);
    const slept = await withDatabaseTargetLock(mainTargetId, () =>
      sleepIdleDatabaseTargetUnlocked({ databaseId, targetId: mainTargetId }),
    );
    expect(slept).toBe(true);
    expect(await targetStatus(mainTargetId)).toBe("stopped");
    // The proxy closed the idle session at commit; Postgres is gone.
    expect(
      await containerState(getDatabaseProxyContainerName(mainTargetId)),
    ).toBe("running");

    const started = Date.now();
    expect(await psql("pdb.frost.internal", "select 40 + 2")).toBe("42");
    console.log(
      `[proxy test] cold internal query took ${Date.now() - started}ms`,
    );
    expect(await targetStatus(mainTargetId)).toBe("active");
  }, 180_000);

  test("a branch can be created from a sleeping main; a manual stop wakes on connect", async () => {
    await stopDatabaseTarget({ databaseId, targetId: mainTargetId });
    expect(await targetStatus(mainTargetId)).toBe("stopped");

    const branch = await createDatabaseTarget({
      databaseId,
      name: "dev",
      sourceTargetName: "main",
    });
    expect(await targetStatus(mainTargetId)).toBe("stopped");
    const branchInfo = await getDatabaseTargetConnectionInfo({
      databaseId,
      targetId: branch.id,
    });
    expect(await psql(branchInfo.internalHost, "select 'branch-ok'")).toBe(
      "branch-ok",
    );

    // The sleeping main wakes through its proxy.
    expect(await psql("pdb.frost.internal", "select 'main-woke'")).toBe(
      "main-woke",
    );
    expect(await targetStatus(mainTargetId)).toBe("active");
  }, 240_000);

  test("disabling scale-to-zero removes the proxy and restores the hostnames", async () => {
    await patchDatabaseTargetRuntimeSettings({
      targetId: mainTargetId,
      scaleToZeroMinutes: null,
    });
    expect(
      await containerState(getDatabaseProxyContainerName(mainTargetId)),
    ).toBeNull();
    expect(await psql("pdb.frost.internal", "select 'direct'")).toBe("direct");
  }, 240_000);
});
