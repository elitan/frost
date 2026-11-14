import {
  getPostgresBackupConfig,
  getScheduleIntervalMs,
  listEnabledPostgresBackupConfigIds,
  resetInterruptedPostgresBackupRuns,
} from "./postgres-backup-config";
import { runPostgresBackup } from "./postgres-backup-runner";

const CHECK_INTERVAL_MS = 60 * 1000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let startupReset: Promise<void> = Promise.resolve();

export function isPostgresBackupDue(input: {
  lastRunAt: number | null;
  intervalValue: number;
  intervalUnit: "minutes" | "hours" | "days";
  now?: number;
}): boolean {
  if (input.lastRunAt === null) {
    return true;
  }

  const now = input.now ?? Date.now();
  const intervalMs = getScheduleIntervalMs({
    intervalValue: input.intervalValue,
    intervalUnit: input.intervalUnit,
  });
  return now - input.lastRunAt >= intervalMs;
}

export async function runScheduledPostgresBackups(): Promise<void> {
  const databaseIds = await listEnabledPostgresBackupConfigIds();

  for (const databaseId of databaseIds) {
    try {
      const config = await getPostgresBackupConfig(databaseId);
      if (!config.enabled) {
        continue;
      }
      if (config.running) {
        continue;
      }
      if (
        !isPostgresBackupDue({
          lastRunAt: config.lastRunAt,
          intervalValue: config.intervalValue,
          intervalUnit: config.intervalUnit,
        })
      ) {
        continue;
      }
      await runPostgresBackup(databaseId);
    } catch (error) {
      console.error("[postgres-backup-scheduler] Error:", error);
    }
  }
}

async function resetInterruptedRuns(): Promise<void> {
  try {
    const count = await resetInterruptedPostgresBackupRuns();
    if (count > 0) {
      console.log(
        `[postgres-backup-scheduler] Reset ${count} backup lock(s) left by an interrupted run`,
      );
    }
  } catch (error) {
    console.error(
      "[postgres-backup-scheduler] Failed to reset interrupted runs:",
      error,
    );
  }
}

function checkAndRun(): void {
  startupReset.then(runScheduledPostgresBackups).catch(function onError(error) {
    console.error("[postgres-backup-scheduler] Error:", error);
  });
}

export function startPostgresBackupScheduler(): void {
  if (intervalId) {
    return;
  }
  startupReset = resetInterruptedRuns();
  intervalId = setInterval(checkAndRun, CHECK_INTERVAL_MS);
  console.log("[postgres-backup-scheduler] Started");
}

export function stopPostgresBackupScheduler(): void {
  if (!intervalId) {
    return;
  }
  clearInterval(intervalId);
  intervalId = null;
  console.log("[postgres-backup-scheduler] Stopped");
}
