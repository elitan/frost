import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildZfsCloneArgs,
  buildZfsCreateArgs,
  findBlockingZfsClones,
  parseZfsSnapshotClones,
  resolveSystemCommand,
  resolveZfsPool,
} from "./zfs-branch-storage";

describe("buildZfsCreateArgs", () => {
  test("includes tuned properties", () => {
    expect(
      buildZfsCreateArgs(
        "tank/frost/databases/a/b/live",
        "/opt/frost/data/postgres/zfs/a/b/live",
      ),
    ).toEqual([
      "create",
      "-p",
      "-o",
      "compression=lz4",
      "-o",
      "recordsize=8k",
      "-o",
      "atime=off",
      "-o",
      "mountpoint=/opt/frost/data/postgres/zfs/a/b/live",
      "tank/frost/databases/a/b/live",
    ]);
  });
});

describe("buildZfsCloneArgs", () => {
  test("includes tuned properties", () => {
    expect(
      buildZfsCloneArgs(
        "tank/frost/databases/a/b/live@frost-1",
        "tank/frost/databases/a/c/live",
        "/opt/frost/data/postgres/zfs/a/c/live",
      ),
    ).toEqual([
      "clone",
      "-p",
      "-o",
      "compression=lz4",
      "-o",
      "recordsize=8k",
      "-o",
      "atime=off",
      "-o",
      "mountpoint=/opt/frost/data/postgres/zfs/a/c/live",
      "tank/frost/databases/a/b/live@frost-1",
      "tank/frost/databases/a/c/live",
    ]);
  });
});

describe("resolveZfsPool", () => {
  test("keeps configured pool", () => {
    expect(
      resolveZfsPool({
        configuredPool: "tank",
        datasetBase: "frost/databases",
        hostState: {
          pools: ["pool-a", "pool-b"],
          datasets: ["pool-b/frost/databases"],
        },
      }),
    ).toBe("tank");
  });

  test("detects a single host pool", () => {
    expect(
      resolveZfsPool({
        datasetBase: "frost/databases",
        hostState: {
          pools: ["tank"],
          datasets: [],
        },
      }),
    ).toBe("tank");
  });

  test("detects pool from existing dataset base", () => {
    expect(
      resolveZfsPool({
        datasetBase: "frost/databases",
        hostState: {
          pools: ["pool-a", "pool-b"],
          datasets: ["pool-b/frost/databases", "pool-b/frost/databases/db-1"],
        },
      }),
    ).toBe("pool-b");
  });
});

describe("resolveSystemCommand", () => {
  test("finds commands in fallback dirs", () => {
    const tempDir = mkdtempSync("/tmp/frost-zfs-command-");
    const commandPath = join(tempDir, "zpool");

    try {
      writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
      chmodSync(commandPath, 0o755);

      expect(resolveSystemCommand("zpool", "", [tempDir])).toBe(commandPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("parseZfsSnapshotClones", () => {
  test("parses snapshot clone lists", () => {
    const output = [
      "tank/frost/db/main/live@frost-1\ttank/frost/db/a/live,tank/frost/db/b/live",
      "tank/frost/db/main/live@frost-2\t-",
      "",
    ].join("\n");

    expect(parseZfsSnapshotClones(output)).toEqual([
      {
        snapshot: "tank/frost/db/main/live@frost-1",
        clones: ["tank/frost/db/a/live", "tank/frost/db/b/live"],
      },
      { snapshot: "tank/frost/db/main/live@frost-2", clones: [] },
    ]);
  });
});

describe("findBlockingZfsClones", () => {
  const snapshots = [
    {
      snapshot: "tank/frost/db1/main/live@frost-1",
      clones: ["tank/frost/db1/a/live", "tank/frost/db2/b/live"],
    },
  ];

  test("reports every clone when nothing is allowed", () => {
    expect(
      findBlockingZfsClones({ snapshots, allowedDatasetPrefixes: [] }),
    ).toEqual(["tank/frost/db1/a/live", "tank/frost/db2/b/live"]);
  });

  test("ignores clones under allowed prefixes", () => {
    expect(
      findBlockingZfsClones({
        snapshots,
        allowedDatasetPrefixes: ["tank/frost/db1"],
      }),
    ).toEqual(["tank/frost/db2/b/live"]);
  });

  test("does not treat a sibling with a shared prefix as allowed", () => {
    expect(
      findBlockingZfsClones({
        snapshots: [
          {
            snapshot: "tank/frost/db1/x@frost-1",
            clones: ["tank/frost/db10/y"],
          },
        ],
        allowedDatasetPrefixes: ["tank/frost/db1"],
      }),
    ).toEqual(["tank/frost/db10/y"]);
  });
});
