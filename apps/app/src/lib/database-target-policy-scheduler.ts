import {
  deleteDatabaseTargetUnlocked,
  stopDatabaseTargetUnlocked,
  withDatabaseTargetLock,
} from "./database-runtime";
import { getDatabaseTargetGatewayActiveConnections } from "./database-target-gateway";
import type { DatabaseTargetStoppedReason } from "./database-target-status";
import { db } from "./db";

const CHECK_INTERVAL_MS = 60_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

type ScaleToZeroTarget = {
  id: string;
  databaseId: string;
  createdAt: number;
  lastActivityAt: number | null;
  scaleToZeroMinutes: number | null;
};

type TtlTarget = {
  id: string;
  databaseId: string;
  name: string;
  createdAt: number;
  ttlValue: number | null;
  ttlUnit: "hours" | "days" | null;
};

type StopTargetInput = {
  databaseId: string;
  targetId: string;
  stoppedReason?: DatabaseTargetStoppedReason | null;
};

type DeleteTargetInput = {
  databaseId: string;
  targetId: string;
};

type DatabaseTargetPolicySchedulerInput = {
  getNow?: () => number;
  listScaleToZeroTargets?: () => Promise<ScaleToZeroTarget[]>;
  listTtlTargets?: () => Promise<TtlTarget[]>;
  /** Reloads one target inside the lock to re-check the policy. */
  getScaleToZeroTarget?: (
    targetId: string,
  ) => Promise<ScaleToZeroTarget | null>;
  getTtlTarget?: (targetId: string) => Promise<TtlTarget | null>;
  getActiveConnections?: (targetId: string) => number;
  /** Called while holding the target lock. */
  stopTarget?: (input: StopTargetInput) => Promise<unknown>;
  /** Called while holding the target lock. */
  deleteTarget?: (input: DeleteTargetInput) => Promise<unknown>;
  withTargetLock?: <T>(targetId: string, task: () => Promise<T>) => Promise<T>;
  logAutoStopError?: (targetId: string, error: unknown) => void;
  logAutoDeleteError?: (targetId: string, error: unknown) => void;
};

export function isDatabaseTargetTtlExpired(input: {
  createdAt: number;
  ttlValue: number;
  ttlUnit: "hours" | "days";
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const multiplier =
    input.ttlUnit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return now - input.createdAt >= input.ttlValue * multiplier;
}

export function isDatabaseTargetIdleDue(input: {
  lastActivityAt: number | null;
  createdAt: number;
  scaleToZeroMinutes: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const lastActivityAt = input.lastActivityAt ?? input.createdAt;
  return now - lastActivityAt >= input.scaleToZeroMinutes * 60 * 1000;
}

function scaleToZeroTargetsQuery() {
  return db
    .selectFrom("databaseTargets")
    .innerJoin("databases", "databases.id", "databaseTargets.databaseId")
    .select([
      "databaseTargets.id",
      "databaseTargets.databaseId",
      "databaseTargets.createdAt",
      "databaseTargets.lastActivityAt",
      "databaseTargets.scaleToZeroMinutes",
    ])
    .where("databaseTargets.kind", "=", "branch")
    .where("databaseTargets.name", "!=", "main")
    .where("databaseTargets.lifecycleStatus", "=", "active")
    .where("databaseTargets.scaleToZeroMinutes", "is not", null)
    .where("databases.engine", "=", "postgres");
}

async function listScaleToZeroTargets(): Promise<ScaleToZeroTarget[]> {
  return scaleToZeroTargetsQuery().execute();
}

async function getScaleToZeroTarget(
  targetId: string,
): Promise<ScaleToZeroTarget | null> {
  const target = await scaleToZeroTargetsQuery()
    .where("databaseTargets.id", "=", targetId)
    .executeTakeFirst();
  return target ?? null;
}

function ttlTargetsQuery() {
  return db
    .selectFrom("databaseTargets")
    .innerJoin("databases", "databases.id", "databaseTargets.databaseId")
    .select([
      "databaseTargets.id",
      "databaseTargets.databaseId",
      "databaseTargets.name",
      "databaseTargets.createdAt",
      "databaseTargets.ttlValue",
      "databaseTargets.ttlUnit",
    ])
    .where("databaseTargets.kind", "=", "branch")
    .where("databaseTargets.name", "!=", "main")
    .where("databaseTargets.ttlValue", "is not", null)
    .where("databaseTargets.ttlUnit", "is not", null)
    .where("databases.engine", "=", "postgres");
}

async function listTtlTargets(): Promise<TtlTarget[]> {
  return ttlTargetsQuery().execute();
}

async function getTtlTarget(targetId: string): Promise<TtlTarget | null> {
  const target = await ttlTargetsQuery()
    .where("databaseTargets.id", "=", targetId)
    .executeTakeFirst();
  return target ?? null;
}

function logAutoStopError(targetId: string, error: unknown): void {
  console.error(
    "[database-target-policy-scheduler] Failed to auto-stop target",
    {
      targetId,
      error,
    },
  );
}

function logAutoDeleteError(targetId: string, error: unknown): void {
  console.error(
    "[database-target-policy-scheduler] Failed to auto-delete target",
    {
      targetId,
      error,
    },
  );
}

function isScaleToZeroTargetDue(
  target: ScaleToZeroTarget,
  now: number,
): boolean {
  if (target.scaleToZeroMinutes === null) {
    return false;
  }
  return isDatabaseTargetIdleDue({
    lastActivityAt: target.lastActivityAt,
    createdAt: target.createdAt,
    scaleToZeroMinutes: target.scaleToZeroMinutes,
    now,
  });
}

function isTtlTargetDue(target: TtlTarget, now: number): boolean {
  if (target.ttlValue === null || target.ttlUnit === null) {
    return false;
  }
  return isDatabaseTargetTtlExpired({
    createdAt: target.createdAt,
    ttlValue: target.ttlValue,
    ttlUnit: target.ttlUnit,
    now,
  });
}

async function runScaleToZeroPolicy(
  now: number,
  input: DatabaseTargetPolicySchedulerInput,
): Promise<void> {
  const targets = await (
    input.listScaleToZeroTargets ?? listScaleToZeroTargets
  )();
  const reloadTarget = input.getScaleToZeroTarget ?? getScaleToZeroTarget;
  const getActiveConnections =
    input.getActiveConnections ?? getDatabaseTargetGatewayActiveConnections;
  const stopTarget = input.stopTarget ?? stopDatabaseTargetUnlocked;
  const withTargetLock = input.withTargetLock ?? withDatabaseTargetLock;
  const onError = input.logAutoStopError ?? logAutoStopError;

  for (const target of targets) {
    if (getActiveConnections(target.id) > 0) {
      continue;
    }
    if (!isScaleToZeroTargetDue(target, now)) {
      continue;
    }

    try {
      await withTargetLock(target.id, async function stopIfStillIdle() {
        // A connection or wake may have happened since the list query.
        if (getActiveConnections(target.id) > 0) {
          return;
        }
        const current = await reloadTarget(target.id);
        if (!current || !isScaleToZeroTargetDue(current, now)) {
          return;
        }
        await stopTarget({
          databaseId: current.databaseId,
          targetId: current.id,
          stoppedReason: "idle",
        });
      });
    } catch (error) {
      onError(target.id, error);
    }
  }
}

async function runTtlPolicy(
  now: number,
  input: DatabaseTargetPolicySchedulerInput,
): Promise<void> {
  const targets = await (input.listTtlTargets ?? listTtlTargets)();
  const reloadTarget = input.getTtlTarget ?? getTtlTarget;
  const getActiveConnections =
    input.getActiveConnections ?? getDatabaseTargetGatewayActiveConnections;
  const deleteTarget = input.deleteTarget ?? deleteDatabaseTargetUnlocked;
  const withTargetLock = input.withTargetLock ?? withDatabaseTargetLock;
  const onError = input.logAutoDeleteError ?? logAutoDeleteError;

  for (const target of targets) {
    if (!isTtlTargetDue(target, now)) {
      continue;
    }
    if (getActiveConnections(target.id) > 0) {
      continue;
    }

    try {
      await withTargetLock(target.id, async function deleteIfStillExpired() {
        if (getActiveConnections(target.id) > 0) {
          return;
        }
        const current = await reloadTarget(target.id);
        if (!current || !isTtlTargetDue(current, now)) {
          return;
        }
        await deleteTarget({
          databaseId: current.databaseId,
          targetId: current.id,
        });
      });
    } catch (error) {
      onError(target.id, error);
    }
  }
}

export async function runDatabaseTargetPolicyScheduler(
  input: DatabaseTargetPolicySchedulerInput = {},
): Promise<void> {
  const now = input.getNow ? input.getNow() : Date.now();
  await runScaleToZeroPolicy(now, input);
  await runTtlPolicy(now, input);
}

function checkAndRun(): void {
  if (tickInFlight) {
    return;
  }
  tickInFlight = true;
  runDatabaseTargetPolicyScheduler()
    .catch(function onError(error) {
      console.error("[database-target-policy-scheduler] Error:", error);
    })
    .finally(function onFinally() {
      tickInFlight = false;
    });
}

export function startDatabaseTargetPolicyScheduler(): void {
  if (intervalId) {
    return;
  }

  intervalId = setInterval(checkAndRun, CHECK_INTERVAL_MS);
  checkAndRun();
  console.log("[database-target-policy-scheduler] Started");
}

export function stopDatabaseTargetPolicyScheduler(): void {
  if (!intervalId) {
    return;
  }

  clearInterval(intervalId);
  intervalId = null;
  console.log("[database-target-policy-scheduler] Stopped");
}
