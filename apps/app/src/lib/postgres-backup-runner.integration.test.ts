import { afterAll, describe, expect, test } from "bun:test";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db";
import { updatePostgresBackupConfig } from "./postgres-backup-config";
import {
  listPostgresBackups,
  restorePostgresBackup,
  runPostgresBackup,
} from "./postgres-backup-runner";
import { startGarageTestS3Server } from "./postgres-backup-test-s3-server";
import { shellEscape } from "./shell-escape";

const execAsync = promisify(exec);

const S3_CONTAINER = "frost-test-postgres-backup-runner-s3";
const POSTGRES_CONTAINER = "frost-test-postgres-backup-runner-postgres";
const S3_PORT = 19996;
const POSTGRES_PORT = 19997;
const S3_BUCKET = "frost-test-runner-backups";

async function startPostgres(): Promise<void> {
  await execAsync(`docker rm -f ${POSTGRES_CONTAINER}`).catch(
    function ignore() {},
  );
  await execAsync(
    `docker run -d --name ${POSTGRES_CONTAINER} -p ${POSTGRES_PORT}:5432 ` +
      `-e POSTGRES_USER=frost -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=frost_main ` +
      `postgres:17-alpine`,
  );
}

async function stopPostgres(): Promise<void> {
  await execAsync(`docker rm -f ${POSTGRES_CONTAINER}`).catch(
    function ignore() {},
  );
}

async function waitForPostgresReady(): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      await execAsync(
        `docker exec ${POSTGRES_CONTAINER} pg_isready -h 127.0.0.1 -U frost -d frost_main`,
      );
      return;
    } catch {
      await new Promise(function wait(resolve) {
        setTimeout(resolve, 1000);
      });
    }
  }

  throw new Error("Postgres did not become ready");
}

async function runSql(sql: string): Promise<void> {
  await execAsync(
    `docker exec -e PGPASSWORD=secret ${POSTGRES_CONTAINER} ` +
      `psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U frost -d frost_main -c ${shellEscape(sql)}`,
  );
}

async function readSingleValue(sql: string): Promise<string> {
  const { stdout } = await execAsync(
    `docker exec -e PGPASSWORD=secret ${POSTGRES_CONTAINER} ` +
      `psql -X -t -A -h 127.0.0.1 -U frost -d frost_main -c ${shellEscape(sql)}`,
  );
  return stdout.trim();
}

async function startPostgresOrSkip(): Promise<boolean> {
  try {
    await startPostgres();
    await waitForPostgresReady();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[test] Postgres container unavailable, skipping: ${message}`);
    await stopPostgres();
    return false;
  }
}

const s3Server = await startGarageTestS3Server({
  containerName: S3_CONTAINER,
  port: S3_PORT,
  bucket: S3_BUCKET,
});
const postgresReady = s3Server ? await startPostgresOrSkip() : false;
if (s3Server && !postgresReady) {
  await s3Server.stop();
}

describe.skipIf(s3Server === null || !postgresReady)(
  "postgres backup runner integration",
  () => {
    const server = s3Server as NonNullable<typeof s3Server>;

    afterAll(async () => {
      await server.stop();
      await stopPostgres();
    });

    test("backup then restore existing branch", async () => {
      const projectId = randomUUID();
      const databaseId = randomUUID();
      const targetId = randomUUID();
      const runtimeServiceId = randomUUID();
      const now = Date.now();
      const targetName = "main";

      try {
        await db
          .insertInto("projects")
          .values({
            id: projectId,
            name: `proj-${projectId.slice(0, 8)}`,
            hostname: null,
            createdAt: now,
          })
          .execute();

        await db
          .insertInto("databases")
          .values({
            id: databaseId,
            projectId,
            name: `pg-${databaseId.slice(0, 8)}`,
            engine: "postgres",
            provider: "mysql-docker",
            createdAt: now,
          })
          .execute();

        await db
          .insertInto("databaseTargets")
          .values({
            id: targetId,
            databaseId,
            name: targetName,
            hostname: targetName,
            kind: "branch",
            sourceTargetId: null,
            runtimeServiceId,
            lifecycleStatus: "active",
            stoppedReason: null,
            providerRefJson: JSON.stringify({
              containerName: POSTGRES_CONTAINER,
              hostPort: POSTGRES_PORT,
              username: "frost",
              password: "secret",
              database: "frost_main",
              ssl: false,
              image: "postgres:17-alpine",
              port: 5432,
              memoryLimit: null,
              cpuLimit: null,
            }),
            createdAt: now,
          })
          .execute();

        await updatePostgresBackupConfig({
          databaseId,
          config: {
            enabled: true,
            selectedTargetIds: [targetId],
            intervalValue: 1,
            intervalUnit: "hours",
            retentionDays: 30,
            s3Provider: "custom",
            s3Endpoint: server.endpoint,
            s3Region: server.region,
            s3Bucket: S3_BUCKET,
            s3Prefix: `runner/${databaseId}`,
            s3AccessKeyId: server.accessKeyId,
            s3SecretAccessKey: server.secretAccessKey,
            s3ForcePathStyle: true,
            includeGlobals: true,
          },
        });

        await runSql("DROP TABLE IF EXISTS backup_test;");
        await runSql("CREATE TABLE backup_test (value TEXT NOT NULL);");
        await runSql("INSERT INTO backup_test(value) VALUES ('before');");

        await runPostgresBackup(databaseId);
        const backups = await listPostgresBackups(databaseId);
        expect(backups.length).toBeGreaterThan(0);

        await runSql("DELETE FROM backup_test;");
        await runSql("INSERT INTO backup_test(value) VALUES ('after');");
        expect(
          await readSingleValue("SELECT value FROM backup_test LIMIT 1;"),
        ).toBe("after");

        await restorePostgresBackup({
          databaseId,
          backupPath: backups[0].backupPath,
          targetBranchName: "main",
          createIfMissing: true,
          allowOverwrite: true,
        });

        expect(
          await readSingleValue("SELECT value FROM backup_test LIMIT 1;"),
        ).toBe("before");
      } finally {
        await db
          .deleteFrom("databaseBackupConfigs")
          .where("databaseId", "=", databaseId)
          .execute();
        await db
          .deleteFrom("databaseTargets")
          .where("databaseId", "=", databaseId)
          .execute();
        await db.deleteFrom("databases").where("id", "=", databaseId).execute();
        await db.deleteFrom("projects").where("id", "=", projectId).execute();
      }
    }, 180000);
  },
);
