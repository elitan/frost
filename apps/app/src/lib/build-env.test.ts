import { describe, expect, test } from "bun:test";
import {
  envVarListToRecord,
  hasPublicBuildEnvPrefix,
  isBuildTimeEnvVar,
  mergeEnvVarLists,
  PUBLIC_BUILD_ENV_PREFIXES,
  selectBuildTimeEnvVars,
} from "./build-env";

describe("hasPublicBuildEnvPrefix", function describePrefix() {
  test("matches every public prefix", function testAllPrefixes() {
    for (const prefix of PUBLIC_BUILD_ENV_PREFIXES) {
      expect(hasPublicBuildEnvPrefix(`${prefix}API_URL`)).toBe(true);
    }
  });

  test("does not match secrets or lowercase prefixes", function testNoMatch() {
    expect(hasPublicBuildEnvPrefix("DATABASE_URL")).toBe(false);
    expect(hasPublicBuildEnvPrefix("API_KEY")).toBe(false);
    expect(hasPublicBuildEnvPrefix("next_public_x")).toBe(false);
    expect(hasPublicBuildEnvPrefix("MY_NEXT_PUBLIC_X")).toBe(false);
  });
});

describe("isBuildTimeEnvVar", function describeIsBuildTime() {
  test("explicit flag wins", function testFlag() {
    expect(isBuildTimeEnvVar({ key: "SECRET", value: "x" })).toBe(false);
    expect(
      isBuildTimeEnvVar({ key: "SECRET", value: "x", buildTime: false }),
    ).toBe(false);
    expect(
      isBuildTimeEnvVar({ key: "SECRET", value: "x", buildTime: true }),
    ).toBe(true);
  });

  test("public prefix is always build-time", function testPrefix() {
    expect(
      isBuildTimeEnvVar({ key: "VITE_API", value: "x", buildTime: false }),
    ).toBe(true);
  });
});

describe("mergeEnvVarLists", function describeMerge() {
  test("service vars override project vars including the flag", function testOverride() {
    const merged = mergeEnvVarLists(
      [
        { key: "SHARED", value: "project", buildTime: true },
        { key: "PROJECT_ONLY", value: "p" },
      ],
      [
        { key: "SHARED", value: "service" },
        { key: "SERVICE_ONLY", value: "s", buildTime: true },
      ],
    );
    expect(merged).toEqual([
      { key: "SHARED", value: "service" },
      { key: "PROJECT_ONLY", value: "p" },
      { key: "SERVICE_ONLY", value: "s", buildTime: true },
    ]);
  });
});

describe("selectBuildTimeEnvVars", function describeSelect() {
  test("keeps flagged and public-prefix vars only", function testSelect() {
    const vars = [
      { key: "DATABASE_URL", value: "postgres://secret" },
      { key: "API_TOKEN", value: "t", buildTime: false },
      { key: "SENTRY_RELEASE", value: "1.0", buildTime: true },
      { key: "NEXT_PUBLIC_API_URL", value: "https://api" },
    ];
    expect(envVarListToRecord(selectBuildTimeEnvVars(vars))).toEqual({
      SENTRY_RELEASE: "1.0",
      NEXT_PUBLIC_API_URL: "https://api",
    });
  });
});
