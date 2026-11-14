import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CamelCasePlugin, CompiledQuery, Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-worker/normal";
import type { DB } from "./db-types.js";
import { runMigrations } from "./migrate";
import {
  getHistoryBucketMs,
  getMetricsHistoryFromDb,
  parseContainerServiceMap,
  pruneOldMetricsFromDb,
  saveMetricsToDb,
} from "./monitoring";

const TEST_DIR = join(process.cwd(), "test-monitoring-tmp");
const TEST_DB = join(TEST_DIR, "test.db");
const TEST_ROW_COUNT = 700_000;

function createTestDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new BunSqliteDialect({
      url: TEST_DB,
      onCreateConnection: async function onCreateConnection(conn) {
        await conn.executeQuery(CompiledQuery.raw("PRAGMA journal_mode = WAL"));
        await conn.executeQuery(
          CompiledQuery.raw("PRAGMA busy_timeout = 5000"),
        );
        await conn.executeQuery(CompiledQuery.raw("PRAGMA foreign_keys = ON"));
      },
    }),
    plugins: [new CamelCasePlugin()],
  });
}

function insertMetricsRows(count: number): void {
  const sqlite = new Database(TEST_DB);
  sqlite.exec("PRAGMA journal_mode = OFF");
  sqlite.exec("PRAGMA synchronous = OFF");
  sqlite.exec("BEGIN");

  const stmt = sqlite.prepare(
    "INSERT INTO metrics (timestamp, type, cpu_percent, memory_percent) VALUES (?, 'system', 1, 1)",
  );

  for (let i = 0; i < count; i += 1) {
    stmt.run(i);
  }

  sqlite.exec("COMMIT");
  sqlite.close();
}

describe("pruneOldMetricsFromDb", function describePruneOldMetrics() {
  beforeEach(function setup() {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    runMigrations({
      dbPath: TEST_DB,
      schemaDir: join(process.cwd(), "schema"),
    });
  });

  afterEach(function cleanup() {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("prunes large metric sets without binding every id", async function testPruneLargeMetricSet() {
    insertMetricsRows(TEST_ROW_COUNT);
    const testDb = createTestDb();

    try {
      const deleted = await pruneOldMetricsFromDb(testDb, TEST_ROW_COUNT);
      const remaining = await testDb
        .selectFrom("metrics")
        .select(testDb.fn.count("id").as("count"))
        .executeTakeFirstOrThrow();

      expect(deleted).toBeGreaterThan(100_000);
      expect(Number(remaining.count)).toBe(TEST_ROW_COUNT - deleted);
    } finally {
      await testDb.destroy();
    }
  });

  test("prunes rows older than the longest history range", async function testPruneByAge() {
    const testDb = createTestDb();
    const now = 30 * 24 * 60 * 60 * 1000;
    try {
      const sqlite = new Database(TEST_DB);
      const stmt = sqlite.prepare(
        "INSERT INTO metrics (timestamp, type, cpu_percent, memory_percent) VALUES (?, 'system', 1, 1)",
      );
      stmt.run(now - 15 * 24 * 60 * 60 * 1000);
      stmt.run(now - 13 * 24 * 60 * 60 * 1000);
      stmt.run(now - 1000);
      sqlite.close();

      const deleted = await pruneOldMetricsFromDb(testDb, now);
      expect(deleted).toBe(1);
    } finally {
      await testDb.destroy();
    }
  });
});

describe("metrics history", function describeMetricsHistory() {
  beforeEach(function setup() {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    runMigrations({
      dbPath: TEST_DB,
      schemaDir: join(process.cwd(), "schema"),
    });
  });

  afterEach(function cleanup() {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("saves a snapshot and downsamples long ranges", async function testHistory() {
    const testDb = createTestDb();
    const now = 100 * 24 * 60 * 60 * 1000;
    try {
      for (let i = 0; i < 2000; i += 1) {
        await saveMetricsToDb(testDb, {
          timestamp: now - i * 15_000,
          system: {
            cpuPercent: 10,
            cpuCores: 1,
            memoryUsed: 1,
            memoryTotal: 2,
            memoryPercent: 50,
            diskUsed: 1,
            diskTotal: 2,
            diskPercent: 50,
          },
          containers: [
            {
              containerId: "abc123def456",
              name: "c1",
              cpuPercent: 20,
              memoryUsage: 100,
              memoryLimit: 200,
              memoryPercent: 50,
              networkRx: 0,
              networkTx: 0,
              serviceId: "svc_1",
            },
          ],
        });
      }

      const history = await getMetricsHistoryFromDb(
        testDb,
        "24h",
        "all",
        undefined,
        now,
      );
      expect(history.system.length).toBeGreaterThan(0);
      expect(history.system.length).toBeLessThanOrEqual(361);
      expect(history.system[0].cpuPercent).toBe(10);
      expect(history.system[0].diskPercent).toBe(50);
      const series = history.containers.abc123def456;
      expect(series.length).toBeLessThanOrEqual(361);
      expect(series[0]).toMatchObject({
        cpuPercent: 20,
        memoryBytes: 100,
        containerId: "abc123def456",
        serviceId: "svc_1",
      });

      const byService = await getMetricsHistoryFromDb(
        testDb,
        "1h",
        "all",
        "svc_1",
        now,
      );
      expect(byService.system.length).toBe(0);
      expect(byService.containers.svc_1.length).toBeGreaterThan(200);
      expect(
        byService.containers.svc_1.every(
          (p, i, arr) => i === 0 || p.timestamp >= arr[i - 1].timestamp,
        ),
      ).toBe(true);
    } finally {
      await testDb.destroy();
    }
  });
});

describe("getHistoryBucketMs", () => {
  test("uses raw resolution for short ranges", () => {
    expect(getHistoryBucketMs(5 * 60 * 1000)).toBe(15_000);
  });

  test("caps points for long ranges", () => {
    const range = 14 * 24 * 60 * 60 * 1000;
    expect(range / getHistoryBucketMs(range)).toBeLessThanOrEqual(360);
  });
});

describe("parseContainerServiceMap", () => {
  test("maps short container ids to service labels", () => {
    const map = parseContainerServiceMap(
      "abc123def4567890\tsvc_1\nfff000111222\t\n\n",
    );
    expect(map.get("abc123def456")).toBe("svc_1");
    expect(map.get("fff000111222")).toBe("");
    expect(map.size).toBe(2);
  });
});
