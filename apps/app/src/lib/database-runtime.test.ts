import { describe, expect, test } from "bun:test";
import {
  assertDatabaseName,
  assertTargetHostname,
  assertTargetName,
  buildDatabaseTargetContainerName,
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
