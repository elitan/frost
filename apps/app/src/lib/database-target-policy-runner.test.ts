import { afterEach, describe, expect, test } from "bun:test";
import { runDatabaseTargetPolicyScheduler } from "./database-target-policy-scheduler";

type ScaleToZeroTargetRow = {
  id: string;
  databaseId: string;
  createdAt: number;
  lastActivityAt: number | null;
  scaleToZeroMinutes: number | null;
};

const stopCalls: Array<{
  databaseId: string;
  targetId: string;
  stoppedReason?: "idle" | "failed" | null;
}> = [];

const deleteCalls: Array<{
  databaseId: string;
  targetId: string;
}> = [];

function resetState() {
  stopCalls.length = 0;
  deleteCalls.length = 0;
}

afterEach(function cleanup() {
  resetState();
});

describe("runDatabaseTargetPolicyScheduler", function describePolicyScheduler() {
  test("passes idle stopped reason when auto-sleep stops a branch", async function testIdleStopReason() {
    const now = Date.UTC(2026, 0, 1, 0, 30, 0);
    const createdAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const scaleToZeroTargets: ScaleToZeroTargetRow[] = [
      {
        id: "dbt_1",
        databaseId: "db_1",
        createdAt,
        lastActivityAt: createdAt,
        scaleToZeroMinutes: 10,
      },
    ];

    await runDatabaseTargetPolicyScheduler({
      getActiveConnections: function getActiveConnections() {
        return 0;
      },
      getNow: function getNow() {
        return now;
      },
      listScaleToZeroTargets: async function listScaleToZeroTargets() {
        return scaleToZeroTargets;
      },
      getScaleToZeroTarget: async function getScaleToZeroTarget(id: string) {
        return (
          scaleToZeroTargets.find(function byId(target) {
            return target.id === id;
          }) ?? null
        );
      },
      listTtlTargets: async function listTtlTargets() {
        return [];
      },
      deleteTarget: async function deleteTarget(input: {
        databaseId: string;
        targetId: string;
      }) {
        deleteCalls.push(input);
      },
      stopTarget: async function stopTarget(input: {
        databaseId: string;
        targetId: string;
        stoppedReason?: "idle" | "failed" | null;
      }) {
        stopCalls.push(input);
      },
    });

    expect(stopCalls).toEqual([
      {
        databaseId: "db_1",
        targetId: "dbt_1",
        stoppedReason: "idle",
      },
    ]);
    expect(deleteCalls).toEqual([]);
  });

  test("re-checks idle condition inside the target lock", async function testRecheckInsideLock() {
    const now = Date.UTC(2026, 0, 1, 0, 30, 0);
    const createdAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const targets: ScaleToZeroTargetRow[] = [
      {
        id: "dbt_conn",
        databaseId: "db_1",
        createdAt,
        lastActivityAt: createdAt,
        scaleToZeroMinutes: 10,
      },
      {
        id: "dbt_active",
        databaseId: "db_1",
        createdAt,
        lastActivityAt: createdAt,
        scaleToZeroMinutes: 10,
      },
      {
        id: "dbt_idle",
        databaseId: "db_1",
        createdAt,
        lastActivityAt: createdAt,
        scaleToZeroMinutes: 10,
      },
    ];
    const connections = new Map<string, number>();
    const lockedTargets: string[] = [];

    await runDatabaseTargetPolicyScheduler({
      getNow: function getNow() {
        return now;
      },
      listScaleToZeroTargets: async function listScaleToZeroTargets() {
        return targets;
      },
      getScaleToZeroTarget: async function getScaleToZeroTarget(id: string) {
        const target = targets.find(function byId(row) {
          return row.id === id;
        });
        if (!target) return null;
        // Activity was recorded after the list query.
        if (id === "dbt_active") {
          return { ...target, lastActivityAt: now - 60_000 };
        }
        return target;
      },
      listTtlTargets: async function listTtlTargets() {
        return [];
      },
      getActiveConnections: function getActiveConnections(id: string) {
        return connections.get(id) ?? 0;
      },
      withTargetLock: async function withTargetLock<T>(
        targetId: string,
        task: () => Promise<T>,
      ): Promise<T> {
        lockedTargets.push(targetId);
        // A client connects while the scheduler waits for the lock.
        if (targetId === "dbt_conn") {
          connections.set(targetId, 1);
        }
        return task();
      },
      stopTarget: async function stopTarget(input: {
        databaseId: string;
        targetId: string;
        stoppedReason?: "idle" | "failed" | null;
      }) {
        stopCalls.push(input);
      },
      deleteTarget: async function deleteTarget(input: {
        databaseId: string;
        targetId: string;
      }) {
        deleteCalls.push(input);
      },
    });

    expect(lockedTargets).toEqual(["dbt_conn", "dbt_active", "dbt_idle"]);
    expect(stopCalls).toEqual([
      { databaseId: "db_1", targetId: "dbt_idle", stoppedReason: "idle" },
    ]);
  });

  test("skips ttl delete when target is gone by the time the lock is held", async function testTtlRecheck() {
    const now = Date.UTC(2026, 0, 3, 0, 0, 0);
    const createdAt = Date.UTC(2026, 0, 1, 0, 0, 0);

    await runDatabaseTargetPolicyScheduler({
      getNow: function getNow() {
        return now;
      },
      listScaleToZeroTargets: async function listScaleToZeroTargets() {
        return [];
      },
      listTtlTargets: async function listTtlTargets() {
        return [
          {
            id: "dbt_gone",
            databaseId: "db_1",
            name: "preview",
            createdAt,
            ttlValue: 1,
            ttlUnit: "days" as const,
          },
          {
            id: "dbt_expired",
            databaseId: "db_1",
            name: "preview-2",
            createdAt,
            ttlValue: 1,
            ttlUnit: "days" as const,
          },
        ];
      },
      getTtlTarget: async function getTtlTarget(id: string) {
        if (id === "dbt_gone") return null;
        return {
          id,
          databaseId: "db_1",
          name: "preview-2",
          createdAt,
          ttlValue: 1,
          ttlUnit: "days" as const,
        };
      },
      getActiveConnections: function getActiveConnections() {
        return 0;
      },
      withTargetLock: async function withTargetLock<T>(
        _targetId: string,
        task: () => Promise<T>,
      ): Promise<T> {
        return task();
      },
      deleteTarget: async function deleteTarget(input: {
        databaseId: string;
        targetId: string;
      }) {
        deleteCalls.push(input);
      },
    });

    expect(deleteCalls).toEqual([
      { databaseId: "db_1", targetId: "dbt_expired" },
    ]);
  });
});
