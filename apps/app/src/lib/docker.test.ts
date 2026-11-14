import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabaseTargetReservedPorts, resolveBuildPaths } from "./docker";

describe("getDatabaseTargetReservedPorts", function describeReservedPorts() {
  test("returns provider and runtime host ports", function testReservedPorts() {
    const ports = getDatabaseTargetReservedPorts({
      providerRefJson: JSON.stringify({
        containerName: "frost-db-test-main",
        hostPort: 10001,
        runtimeHostPort: 10002,
      }),
      runtimeHostPort: 10003,
    });

    expect(ports.sort()).toEqual([10001, 10002, 10003]);
  });

  test("deduplicates repeated ports", function testDeduplicatePorts() {
    const ports = getDatabaseTargetReservedPorts({
      providerRefJson: JSON.stringify({
        containerName: "frost-db-test-main",
        hostPort: 10001,
        runtimeHostPort: 10001,
      }),
      runtimeHostPort: 10001,
    });

    expect(ports).toEqual([10001]);
  });

  test("ignores malformed provider refs", function testMalformedProviderRef() {
    const ports = getDatabaseTargetReservedPorts({
      providerRefJson: "{not-json",
      runtimeHostPort: 10003,
    });

    expect(ports).toEqual([10003]);
  });
});

describe("resolveBuildPaths", function describeResolveBuildPaths() {
  const repo = "/repos/my-app";

  test("keeps in-repo paths", function testInRepo() {
    expect(resolveBuildPaths(repo, "Dockerfile")).toEqual({
      contextPath: repo,
      dockerfile: "Dockerfile",
    });
    expect(
      resolveBuildPaths(repo, "docker/Dockerfile.prod", "apps/web"),
    ).toEqual({
      contextPath: "/repos/my-app/apps/web",
      dockerfile: "../../docker/Dockerfile.prod",
    });
  });

  test("rejects build context escaping the repo", function testContextEscape() {
    expect(() => resolveBuildPaths(repo, "Dockerfile", "../other")).toThrow(
      /outside the repository/,
    );
    expect(() => resolveBuildPaths(repo, "Dockerfile", "/etc")).toThrow(
      /outside the repository/,
    );
  });

  test("rejects dockerfile escaping the repo", function testDockerfileEscape() {
    expect(() => resolveBuildPaths(repo, "../../etc/passwd")).toThrow(
      /outside the repository/,
    );
    expect(() => resolveBuildPaths(repo, "/etc/passwd")).toThrow(
      /outside the repository/,
    );
  });

  test("allows names starting with dots", function testDotNames() {
    expect(resolveBuildPaths(repo, "..docker/Dockerfile").dockerfile).toBe(
      "..docker/Dockerfile",
    );
  });

  test("rejects symlinked build context", function testSymlinkContext() {
    const root = mkdtempSync(join(tmpdir(), "frost-ctx-"));
    try {
      const repoDir = join(root, "repo");
      mkdirSync(repoDir);
      mkdirSync(join(root, "outside"));
      symlinkSync(join(root, "outside"), join(repoDir, "ctx"));
      expect(() => resolveBuildPaths(repoDir, "Dockerfile", "ctx")).toThrow(
        /symlink/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
