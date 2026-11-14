import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapshot,
  createSnapshotWithConnection,
  formatSnapshotName,
  getSnapshotDir,
  isDailySnapshotDue,
  listSnapshots,
  parseSnapshotName,
  selectExpiredRemoteKeys,
  selectSnapshotsToDelete,
} from "./frost-db-snapshot";

const DAY = 24 * 60 * 60 * 1000;

function nameAt(kind: "daily" | "pre-migration", ms: number): string {
  return formatSnapshotName(kind, new Date(ms));
}

describe("snapshot naming", () => {
  test("formats a sortable, filesystem-safe name", () => {
    const name = formatSnapshotName(
      "daily",
      new Date(Date.UTC(2026, 10, 14, 3, 4, 5, 6)),
    );
    expect(name).toBe("frost-daily-2026-11-14T03-04-05-006Z.db");
  });

  test("round-trips through parse", () => {
    const ms = Date.UTC(2026, 0, 2, 13, 14, 15, 999);
    const parsed = parseSnapshotName(nameAt("pre-migration", ms));
    expect(parsed).toEqual({
      name: "frost-pre-migration-2026-01-02T13-14-15-999Z.db",
      kind: "pre-migration",
      createdAt: ms,
    });
  });

  test("ignores unrelated files and temp files", () => {
    expect(parseSnapshotName("frost.db")).toBeNull();
    expect(
      parseSnapshotName("frost-daily-2026-11-14T03-04-05-006Z.db.tmp"),
    ).toBeNull();
    expect(
      parseSnapshotName("frost-weekly-2026-11-14T03-04-05-006Z.db"),
    ).toBeNull();
  });
});

describe("selectSnapshotsToDelete", () => {
  test("keeps newest N per kind independently", () => {
    const base = Date.UTC(2026, 0, 1);
    const daily = Array.from({ length: 9 }, (_, i) =>
      nameAt("daily", base + i * DAY),
    );
    const pre = Array.from({ length: 6 }, (_, i) =>
      nameAt("pre-migration", base + i * 1000),
    );
    const shuffled = [...daily, ...pre, "frost.db", "notes.txt"].reverse();

    const toDelete = selectSnapshotsToDelete(shuffled);

    expect(toDelete.sort()).toEqual([daily[0], daily[1], pre[0]].sort());
  });

  test("deletes nothing when under the limit", () => {
    const names = [nameAt("daily", 1000), nameAt("pre-migration", 2000)];
    expect(selectSnapshotsToDelete(names)).toEqual([]);
  });

  test("respects custom keep counts", () => {
    const names = [1, 2, 3].map((i) => nameAt("daily", i * DAY));
    expect(
      selectSnapshotsToDelete(names, { daily: 1, "pre-migration": 1 }),
    ).toEqual([names[1], names[0]]);
  });
});

describe("selectExpiredRemoteKeys", () => {
  test("only expires parsable keys older than retention", () => {
    const now = Date.UTC(2026, 10, 14);
    const old = `frost-backups/frost-system/${nameAt("daily", now - 15 * DAY)}`;
    const fresh = `frost-backups/frost-system/${nameAt("daily", now - 2 * DAY)}`;
    const foreign = "frost-backups/frost-system/something-else.db";
    expect(selectExpiredRemoteKeys([old, fresh, foreign], 14, now)).toEqual([
      old,
    ]);
  });
});

describe("isDailySnapshotDue", () => {
  test("is due when no daily snapshot exists or after 24h", () => {
    const now = Date.UTC(2026, 10, 14, 12);
    expect(isDailySnapshotDue(null, now)).toBe(true);
    expect(isDailySnapshotDue(now - DAY + 1, now)).toBe(false);
    expect(isDailySnapshotDue(now - DAY, now)).toBe(true);
  });
});

describe("VACUUM INTO snapshots", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frost-snapshot-test-"));
    dbPath = join(dir, "frost.db");
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)");
    sqlite.exec("INSERT INTO projects VALUES ('p1', 'one'), ('p2', 'two')");
    sqlite.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readProjects(path: string): string[] {
    const snap = new Database(path, { readonly: true });
    try {
      const rows = snap
        .query("SELECT name FROM projects ORDER BY id")
        .all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    } finally {
      snap.close();
    }
  }

  test("subprocess snapshot produces a readable DB with 0600/0700 perms", async () => {
    const path = await createSnapshot(dbPath, "daily");

    expect(path.startsWith(getSnapshotDir(dbPath))).toBe(true);
    expect(readProjects(path)).toEqual(["one", "two"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(getSnapshotDir(dbPath)).mode & 0o777).toBe(0o700);
    expect(listSnapshots(getSnapshotDir(dbPath))).toHaveLength(1);
  });

  test("snapshot captures data written by a live WAL connection", async () => {
    const live = new Database(dbPath);
    live.exec("PRAGMA journal_mode = WAL");
    live.exec("INSERT INTO projects VALUES ('p3', 'three')");
    try {
      const path = await createSnapshot(dbPath, "daily");
      expect(readProjects(path)).toEqual(["one", "two", "three"]);
    } finally {
      live.close();
    }
  });

  test("connection snapshot prunes old pre-migration snapshots", () => {
    const backupDir = getSnapshotDir(dbPath);
    const sqlite = new Database(dbPath);
    try {
      for (let i = 0; i < 7; i++) {
        createSnapshotWithConnection(
          sqlite,
          dbPath,
          "pre-migration",
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        );
      }
    } finally {
      sqlite.close();
    }
    const remaining = listSnapshots(backupDir);
    expect(remaining).toHaveLength(5);
    expect(remaining[0].name).toBe(
      formatSnapshotName(
        "pre-migration",
        new Date(Date.UTC(2026, 0, 1, 0, 0, 6)),
      ),
    );
    expect(readProjects(remaining[0].path)).toEqual(["one", "two"]);
  });

  test("failed snapshot leaves no temp file behind", async () => {
    writeFileSync(join(dir, "not-a-db"), "garbage");
    await expect(
      createSnapshot(join(dir, "not-a-db"), "daily"),
    ).rejects.toThrow();
    const backupDir = getSnapshotDir(join(dir, "not-a-db"));
    expect(readdirSync(backupDir)).toEqual([]);
  });
});
