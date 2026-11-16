import { describe, expect, test } from "bun:test";
import {
  assertDatabaseName,
  assertTargetHostname,
  assertTargetName,
  buildDatabaseTargetContainerName,
  buildPostgresTlsProbeArgs,
  getRuntimePortBinding,
  isTargetIdleEnough,
  parsePostgresActivity,
  parseProxyIdleSeconds,
  usesDatabaseProxy,
} from "./database-runtime";

describe("buildDatabaseTargetContainerName", function describeContainerName() {
  test("derives a unique name from database and target ids", function testUnique() {
    const databaseId = "db_abcdefghij0123456789";
    const first = buildDatabaseTargetContainerName({
      databaseId,
      targetId: "dbt_aaaaaaaaaaaaaaaaaaaa",
    });
    const second = buildDatabaseTargetContainerName({
      databaseId,
      targetId: "dbt_aaaaaaaaaaaaaaaaaaab",
    });

    expect(first).toBe(
      "frost-db-db-abcdefghij0123456789-dbt-aaaaaaaaaaaaaaaaaaaa",
    );
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
  });

  test("falls back to a hash when ids are too long", function testLongIds() {
    const databaseId = `db_${"x".repeat(40)}`;
    const first = buildDatabaseTargetContainerName({
      databaseId,
      targetId: `dbt_${"y".repeat(40)}1`,
    });
    const second = buildDatabaseTargetContainerName({
      databaseId,
      targetId: `dbt_${"y".repeat(40)}2`,
    });

    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
  });
});

describe("name validation", function describeNameValidation() {
  test("accepts single hyphens", function testValid() {
    expect(() => assertDatabaseName("my-db")).not.toThrow();
    expect(() => assertTargetName("feature-1")).not.toThrow();
    expect(() => assertTargetHostname("feature-1")).not.toThrow();
  });

  test("rejects the branch alias separator", function testSeparator() {
    expect(() => assertDatabaseName("my--db")).toThrow(/--/);
    expect(() => assertTargetName("feature--1")).toThrow(/--/);
    expect(() => assertTargetHostname("feature--1")).toThrow(/--/);
  });
});

describe("getRuntimePortBinding", function describePortBinding() {
  test("public host port is published on all interfaces", function testPublic() {
    expect(getRuntimePortBinding(10001, { hostPort: 10001 })).toBe("all");
  });

  test("hidden scale-to-zero runtime port is loopback only", function testRuntime() {
    expect(getRuntimePortBinding(10002, { hostPort: 10001 })).toBe("loopback");
  });

  test("freshly allocated runtime port is loopback only", function testAllocated() {
    expect(getRuntimePortBinding(undefined, { hostPort: 10001 })).toBe(
      "loopback",
    );
  });
});

describe("buildPostgresTlsProbeArgs", function describeTlsProbe() {
  test("probes inside the target network namespace", function testProbe() {
    const args = buildPostgresTlsProbeArgs({
      containerName: "frost-db-x-main",
      image: "postgres:17",
      port: 5432,
      username: "frost",
      database: "app",
    });

    expect(args[args.indexOf("--network") + 1]).toBe(
      "container:frost-db-x-main",
    );
    expect(args).toContain(
      "host=127.0.0.1 port=5432 user=frost dbname=app sslmode=require connect_timeout=5",
    );
    expect(args.some((arg) => arg.includes("host.docker.internal"))).toBe(
      false,
    );
  });
});

describe("scale-to-zero idle checks", function describeIdleChecks() {
  test("parses pg_stat_activity output", function testParseActivity() {
    expect(parsePostgresActivity("0,-1\n")).toEqual({
      busy: 0,
      idleSeconds: null,
    });
    expect(parsePostgresActivity("2,17")).toEqual({ busy: 2, idleSeconds: 17 });
    expect(() => parsePostgresActivity("psql: error")).toThrow();
  });

  test("parses the proxy's idle seconds", function testParseProxyIdle() {
    expect(
      parseProxyIdleSeconds(
        "ok phase=awake forwarding=3 held=0 touched=false idle_secs=42",
      ),
    ).toBe(42);
    expect(parseProxyIdleSeconds("busy")).toBeNull();
  });

  test("busy sessions, recent queries or recent traffic keep a target awake", function testIdleEnough() {
    const idle = { busy: 0, idleSeconds: 600 };
    expect(
      isTargetIdleEnough({
        activity: idle,
        proxyIdleSeconds: 600,
        minIdleSeconds: 300,
      }),
    ).toBe(true);
    expect(
      isTargetIdleEnough({
        activity: { busy: 0, idleSeconds: null },
        proxyIdleSeconds: null,
        minIdleSeconds: 300,
      }),
    ).toBe(true);
    // An open transaction or running query, however old.
    expect(
      isTargetIdleEnough({
        activity: { busy: 1, idleSeconds: 9999 },
        proxyIdleSeconds: 9999,
        minIdleSeconds: 300,
      }),
    ).toBe(false);
    // A pooled connection queried recently.
    expect(
      isTargetIdleEnough({
        activity: { busy: 0, idleSeconds: 10 },
        proxyIdleSeconds: 600,
        minIdleSeconds: 300,
      }),
    ).toBe(false);
    // Short-lived connections leave no session behind, only proxy traffic.
    expect(
      isTargetIdleEnough({
        activity: { busy: 0, idleSeconds: null },
        proxyIdleSeconds: 5,
        minIdleSeconds: 300,
      }),
    ).toBe(false);
  });

  test("only scale-to-zero postgres targets use the proxy", function testUsesProxy() {
    expect(
      usesDatabaseProxy({ engine: "postgres" }, { scaleToZeroMinutes: 5 }),
    ).toBe(true);
    expect(
      usesDatabaseProxy({ engine: "postgres" }, { scaleToZeroMinutes: null }),
    ).toBe(false);
    expect(
      usesDatabaseProxy({ engine: "mysql" }, { scaleToZeroMinutes: 5 }),
    ).toBe(false);
  });
});
