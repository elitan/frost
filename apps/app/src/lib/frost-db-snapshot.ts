import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type FrostSnapshotKind = "daily" | "pre-migration";

export const DAILY_SNAPSHOTS_TO_KEEP = 7;
export const PRE_MIGRATION_SNAPSHOTS_TO_KEEP = 5;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_SUBPROCESS_TIMEOUT_MS = 30 * 60 * 1000;

const snapshotNamePattern =
  /^frost-(daily|pre-migration)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/;

export interface FrostSnapshotFile {
  name: string;
  kind: FrostSnapshotKind;
  createdAt: number;
}

export interface FrostSnapshotInfo extends FrostSnapshotFile {
  path: string;
  size: number;
}

export function getSnapshotDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

export function formatSnapshotName(
  kind: FrostSnapshotKind,
  date: Date = new Date(),
): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `frost-${kind}-${stamp}.db`;
}

export function parseSnapshotName(name: string): FrostSnapshotFile | null {
  const match = name.match(snapshotNamePattern);
  if (!match) {
    return null;
  }
  const [, kind, year, month, day, hour, minute, second, ms] = match;
  const createdAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms),
  );
  if (Number.isNaN(createdAt)) {
    return null;
  }
  return { name, kind: kind as FrostSnapshotKind, createdAt };
}

function newestFirst(a: FrostSnapshotFile, b: FrostSnapshotFile): number {
  return b.createdAt - a.createdAt || b.name.localeCompare(a.name);
}

export function selectSnapshotsToDelete(
  names: string[],
  keep: Record<FrostSnapshotKind, number> = {
    daily: DAILY_SNAPSHOTS_TO_KEEP,
    "pre-migration": PRE_MIGRATION_SNAPSHOTS_TO_KEEP,
  },
): string[] {
  const parsed = names
    .map(parseSnapshotName)
    .filter((item): item is FrostSnapshotFile => item !== null);
  const toDelete: string[] = [];

  for (const kind of ["daily", "pre-migration"] as const) {
    const ofKind = parsed
      .filter((item) => item.kind === kind)
      .sort(newestFirst);
    for (const item of ofKind.slice(Math.max(0, keep[kind]))) {
      toDelete.push(item.name);
    }
  }

  return toDelete;
}

export function selectExpiredRemoteKeys(
  keys: string[],
  retentionDays: number,
  now: number = Date.now(),
): string[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return keys.filter(function isExpired(key) {
    const name = key.slice(key.lastIndexOf("/") + 1);
    const parsed = parseSnapshotName(name);
    return parsed !== null && parsed.createdAt < cutoff;
  });
}

export function isDailySnapshotDue(
  latestDailyAt: number | null,
  now: number = Date.now(),
): boolean {
  return latestDailyAt === null || now - latestDailyAt >= DAILY_INTERVAL_MS;
}

export function ensureSnapshotDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
}

export function listSnapshots(dir: string): FrostSnapshotInfo[] {
  if (!existsSync(dir)) {
    return [];
  }
  const result: FrostSnapshotInfo[] = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseSnapshotName(name);
    if (!parsed) {
      continue;
    }
    const path = join(dir, name);
    try {
      result.push({ ...parsed, path, size: statSync(path).size });
    } catch {}
  }
  return result.sort(newestFirst);
}

export function pruneSnapshots(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const toDelete = selectSnapshotsToDelete(readdirSync(dir));
  for (const name of toDelete) {
    rmSync(join(dir, name), { force: true });
  }
  return toDelete;
}

function prepareSnapshotTarget(
  dbPath: string,
  kind: FrostSnapshotKind,
  now: Date,
): { dir: string; finalPath: string; tmpPath: string } {
  const dir = getSnapshotDir(dbPath);
  ensureSnapshotDir(dir);
  const finalPath = join(dir, formatSnapshotName(kind, now));
  const tmpPath = `${finalPath}.tmp`;
  rmSync(tmpPath, { force: true });
  return { dir, finalPath, tmpPath };
}

function finalizeSnapshot(tmpPath: string, finalPath: string): void {
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, finalPath);
}

/**
 * Synchronous snapshot on an already-open connection. Only used at startup
 * right before migrations, when blocking is expected and nothing else runs.
 */
export function createSnapshotWithConnection(
  sqlite: Database,
  dbPath: string,
  kind: FrostSnapshotKind,
  now: Date = new Date(),
): string {
  const { dir, finalPath, tmpPath } = prepareSnapshotTarget(dbPath, kind, now);
  try {
    sqlite.query("VACUUM INTO ?").run(tmpPath);
    finalizeSnapshot(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  pruneSnapshots(dir);
  return finalPath;
}

const SUBPROCESS_SCRIPT = `
const { Database } = require("bun:sqlite");
const sqlite = new Database(process.env.FROST_SNAPSHOT_SRC);
try {
  sqlite.exec("PRAGMA busy_timeout = 30000");
  sqlite.query("VACUUM INTO ?").run(process.env.FROST_SNAPSHOT_DEST);
} finally {
  sqlite.close();
}
`;

function runVacuumIntoSubprocess(src: string, dest: string): Promise<void> {
  return new Promise(function runSubprocess(resolve, reject) {
    execFile(
      process.execPath,
      ["-e", SUBPROCESS_SCRIPT],
      {
        env: {
          ...process.env,
          FROST_SNAPSHOT_SRC: src,
          FROST_SNAPSHOT_DEST: dest,
        },
        timeout: SNAPSHOT_SUBPROCESS_TIMEOUT_MS,
      },
      function onExit(error, _stdout, stderr) {
        if (error) {
          const detail = String(stderr ?? "").trim();
          reject(
            new Error(
              detail.length > 0
                ? `VACUUM INTO failed: ${detail.slice(-500)}`
                : `VACUUM INTO failed: ${error.message}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Snapshot a live database without blocking the server's event loop.
 * bun:sqlite is synchronous, so VACUUM INTO runs in a short-lived `bun`
 * subprocess on its own connection; WAL mode lets it read a consistent view
 * while the server keeps writing.
 */
export async function createSnapshot(
  dbPath: string,
  kind: FrostSnapshotKind,
  now: Date = new Date(),
): Promise<string> {
  const { dir, finalPath, tmpPath } = prepareSnapshotTarget(dbPath, kind, now);
  try {
    await runVacuumIntoSubprocess(dbPath, tmpPath);
    finalizeSnapshot(tmpPath, finalPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  pruneSnapshots(dir);
  return finalPath;
}
