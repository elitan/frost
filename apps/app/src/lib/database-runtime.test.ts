import { describe, expect, test } from "bun:test";
import {
  assertDatabaseName,
  assertTargetHostname,
  assertTargetName,
  buildDatabaseTargetContainerName,
  buildPostgresTlsProbeArgs,
  getRuntimePortBinding,
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
