import { basename } from "node:path";
import { getSetting, setSetting } from "./auth";
import { decrypt } from "./crypto";
import { db } from "./db";
import {
  createSnapshot,
  type FrostSnapshotKind,
  getSnapshotDir,
  isDailySnapshotDue,
  listSnapshots,
  selectExpiredRemoteKeys,
} from "./frost-db-snapshot";
import { getDbPath } from "./paths";
import {
  createPostgresBackupS3Client,
  deleteS3Objects,
  joinS3Key,
  listS3Objects,
  normalizeS3Prefix,
  type PostgresBackupS3Config,
  type PostgresBackupS3Provider,
  putFileToS3,
} from "./postgres-backup-s3";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
export const OFFSITE_RETENTION_DAYS = 14;
export const OFFSITE_PATH_SEGMENT = "frost-system";

const SETTING_LAST_SNAPSHOT_ERROR = "frost_backup_last_snapshot_error";
const SETTING_LAST_OFFSITE_AT = "frost_backup_last_offsite_at";
const SETTING_LAST_OFFSITE_ERROR = "frost_backup_last_offsite_error";

let intervalId: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

export interface OffsiteDestination {
  databaseId: string;
  bucket: string;
  keyPrefix: string;
  s3: PostgresBackupS3Config;
}

export interface FrostBackupStatus {
  localDir: string;
  snapshots: Array<{
    name: string;
    kind: FrostSnapshotKind;
    size: number;
    createdAt: number;
  }>;
  lastSnapshotAt: number | null;
  lastSnapshotError: string | null;
  offsiteDestination: string | null;
  lastOffsiteAt: number | null;
  lastOffsiteError: string | null;
  running: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Offsite uploads reuse a Postgres backup S3 destination. When several exist,
 * the oldest enabled config (by createdAt, then databaseId) wins. createdAt is
 * used rather than updatedAt because updatedAt is bumped on every backup run,
 * which would make the choice flip between buckets.
 */
export async function getOffsiteDestination(): Promise<OffsiteDestination | null> {
  const row = await db
    .selectFrom("databaseBackupConfigs")
    .select([
      "databaseId",
      "s3Provider",
      "s3Endpoint",
      "s3Region",
      "s3Bucket",
      "s3Prefix",
      "s3AccessKeyId",
      "s3SecretAccessKeyEncrypted",
      "s3ForcePathStyle",
    ])
    .where("enabled", "=", true)
    .where("s3Bucket", "!=", "")
    .where("s3SecretAccessKeyEncrypted", "!=", "")
    .orderBy("createdAt", "asc")
    .orderBy("databaseId", "asc")
    .limit(1)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  const keyPrefix = joinS3Key(
    normalizeS3Prefix(row.s3Prefix),
    OFFSITE_PATH_SEGMENT,
  );
  return {
    databaseId: row.databaseId,
    bucket: row.s3Bucket,
    keyPrefix,
    s3: {
      provider: row.s3Provider as PostgresBackupS3Provider,
      endpoint: row.s3Endpoint,
      region: row.s3Region,
      bucket: row.s3Bucket,
      prefix: row.s3Prefix,
      accessKeyId: row.s3AccessKeyId,
      secretAccessKey: decrypt(row.s3SecretAccessKeyEncrypted),
      forcePathStyle: Boolean(row.s3ForcePathStyle),
    },
  };
}

export async function uploadSnapshotOffsite(
  snapshotPath: string,
  destination: OffsiteDestination,
  now: number = Date.now(),
): Promise<{ key: string; deleted: number }> {
  const client = createPostgresBackupS3Client(destination.s3);
  try {
    const key = joinS3Key(destination.keyPrefix, basename(snapshotPath));
    await putFileToS3({
      client,
      bucket: destination.bucket,
      key,
      filePath: snapshotPath,
      contentType: "application/vnd.sqlite3",
    });

    const objects = await listS3Objects({
      client,
      bucket: destination.bucket,
      prefix: `${destination.keyPrefix}/`,
    });
    const expired = selectExpiredRemoteKeys(
      objects.map((object) => object.key),
      OFFSITE_RETENTION_DAYS,
      now,
    ).filter((expiredKey) => expiredKey !== key);
    const deleted = await deleteS3Objects({
      client,
      bucket: destination.bucket,
      keys: expired,
    });
    return { key, deleted };
  } finally {
    client.destroy();
  }
}

async function runDailyBackup(dbPath: string): Promise<void> {
  let snapshotPath: string;
  try {
    snapshotPath = await createSnapshot(dbPath, "daily");
    await setSetting(SETTING_LAST_SNAPSHOT_ERROR, "");
    console.log(`[frost-backup] Snapshot written: ${snapshotPath}`);
  } catch (error) {
    console.error("[frost-backup] Snapshot failed:", error);
    await setSetting(SETTING_LAST_SNAPSHOT_ERROR, errorMessage(error));
    return;
  }

  let destination: OffsiteDestination | null;
  try {
    destination = await getOffsiteDestination();
  } catch (error) {
    console.error("[frost-backup] Failed to load offsite destination:", error);
    await setSetting(SETTING_LAST_OFFSITE_ERROR, errorMessage(error));
    return;
  }
  if (!destination) {
    return;
  }

  try {
    const result = await uploadSnapshotOffsite(snapshotPath, destination);
    await setSetting(SETTING_LAST_OFFSITE_AT, String(Date.now()));
    await setSetting(SETTING_LAST_OFFSITE_ERROR, "");
    console.log(
      `[frost-backup] Uploaded s3://${destination.bucket}/${result.key}` +
        (result.deleted > 0 ? `, removed ${result.deleted} expired` : ""),
    );
  } catch (error) {
    console.error("[frost-backup] Offsite upload failed:", error);
    await setSetting(SETTING_LAST_OFFSITE_ERROR, errorMessage(error));
  }
}

export function runFrostBackupIfDue(
  dbPath: string = getDbPath(),
  now: number = Date.now(),
): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  const latestDaily = listSnapshots(getSnapshotDir(dbPath)).find(
    (snapshot) => snapshot.kind === "daily",
  );
  if (!isDailySnapshotDue(latestDaily?.createdAt ?? null, now)) {
    return Promise.resolve();
  }
  inFlight = runDailyBackup(dbPath)
    .catch(function onError(error) {
      console.error("[frost-backup] Error:", error);
    })
    .finally(function clearInFlight() {
      inFlight = null;
    });
  return inFlight;
}

function checkAndRun(): void {
  runFrostBackupIfDue().catch(function onError(error) {
    console.error("[frost-backup] Error:", error);
  });
}

export function startFrostBackupScheduler(): void {
  if (intervalId) {
    return;
  }
  startupTimer = setTimeout(checkAndRun, STARTUP_DELAY_MS);
  intervalId = setInterval(checkAndRun, CHECK_INTERVAL_MS);
  console.log("[frost-backup] Scheduler started");
}

export function stopFrostBackupScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export async function getFrostBackupStatus(): Promise<FrostBackupStatus> {
  const localDir = getSnapshotDir(getDbPath());
  const [lastSnapshotError, lastOffsiteAt, lastOffsiteError, destination] =
    await Promise.all([
      getSetting(SETTING_LAST_SNAPSHOT_ERROR),
      getSetting(SETTING_LAST_OFFSITE_AT),
      getSetting(SETTING_LAST_OFFSITE_ERROR),
      getOffsiteDestination().catch(() => null),
    ]);

  const snapshots = listSnapshots(localDir).map(function toView(snapshot) {
    return {
      name: snapshot.name,
      kind: snapshot.kind,
      size: snapshot.size,
      createdAt: snapshot.createdAt,
    };
  });

  return {
    localDir,
    snapshots,
    lastSnapshotAt: snapshots[0]?.createdAt ?? null,
    lastSnapshotError: lastSnapshotError || null,
    offsiteDestination: destination
      ? `s3://${destination.bucket}/${destination.keyPrefix}/`
      : null,
    lastOffsiteAt: parseTimestamp(lastOffsiteAt),
    lastOffsiteError: lastOffsiteError || null,
    running: inFlight !== null,
  };
}
