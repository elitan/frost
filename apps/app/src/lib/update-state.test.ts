import { describe, expect, test } from "bun:test";
import { isAutoUpdateEnabled, parseUpdateResult } from "./update-state";

describe("isAutoUpdateEnabled", function describeAutoUpdate() {
  test("defaults to disabled when unset", function testUnset() {
    expect(isAutoUpdateEnabled(null)).toBe(false);
    expect(isAutoUpdateEnabled(undefined)).toBe(false);
    expect(isAutoUpdateEnabled("")).toBe(false);
  });

  test("only an explicit true enables it", function testExplicit() {
    expect(isAutoUpdateEnabled("true")).toBe(true);
    expect(isAutoUpdateEnabled("false")).toBe(false);
    expect(isAutoUpdateEnabled("1")).toBe(false);
  });
});

describe("parseUpdateResult", function describeParse() {
  test("parses success with version", function testSuccess() {
    expect(parseUpdateResult("success:1.2.3\n")).toEqual({
      completed: true,
      success: true,
      newVersion: "1.2.3",
    });
  });

  test("parses plain failure", function testFailed() {
    expect(parseUpdateResult("failed\n")).toEqual({
      completed: true,
      success: false,
      newVersion: null,
    });
  });

  test("parses failure with reason", function testFailedReason() {
    expect(parseUpdateResult("failed:health check")).toEqual({
      completed: true,
      success: false,
      newVersion: null,
    });
  });

  test("treats unknown content as not completed", function testUnknown() {
    expect(parseUpdateResult("")).toEqual({
      completed: false,
      success: false,
      newVersion: null,
    });
    expect(parseUpdateResult("in-progress")).toEqual({
      completed: false,
      success: false,
      newVersion: null,
    });
  });
});
