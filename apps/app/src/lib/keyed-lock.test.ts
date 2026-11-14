import { describe, expect, test } from "bun:test";
import { getActiveLockCount, isLocked, withLock } from "./keyed-lock";

function sleep(ms: number): Promise<void> {
  return new Promise(function onCreate(resolve) {
    setTimeout(resolve, ms);
  });
}

describe("withLock", function describeWithLock() {
  test("serializes tasks with the same key in FIFO order", async function testFifo() {
    const events: string[] = [];

    await Promise.all(
      [30, 0, 10].map(function runTask(delay, index) {
        return withLock("same", async function task() {
          events.push(`${index}:start`);
          await sleep(delay);
          events.push(`${index}:end`);
        });
      }),
    );

    expect(events).toEqual([
      "0:start",
      "0:end",
      "1:start",
      "1:end",
      "2:start",
      "2:end",
    ]);
  });

  test("runs tasks with different keys concurrently", async function testParallel() {
    let running = 0;
    let peak = 0;

    async function task(): Promise<void> {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(20);
      running -= 1;
    }

    await Promise.all([withLock("a", task), withLock("b", task)]);

    expect(peak).toBe(2);
  });

  test("returns the task result", async function testResult() {
    const value = await withLock("result", async function task() {
      return 42;
    });
    expect(value).toBe(42);
  });

  test("a rejected task does not block later tasks", async function testRejection() {
    const first = withLock("reject", async function failing() {
      await sleep(5);
      throw new Error("boom");
    });
    const second = withLock("reject", async function succeeding() {
      return "ok";
    });

    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });

  test("a synchronous throw releases the lock", async function testSyncThrow() {
    await expect(
      withLock("sync-throw", function failing(): Promise<void> {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");

    expect(await withLock("sync-throw", async () => "next")).toBe("next");
  });

  test("cleans up keys once the queue drains", async function testCleanup() {
    const before = getActiveLockCount();
    const pending = withLock("cleanup", async function task() {
      expect(isLocked("cleanup")).toBe(true);
      await sleep(5);
    });
    const queued = withLock("cleanup", async function task() {});

    await Promise.all([pending, queued]);

    expect(isLocked("cleanup")).toBe(false);
    expect(getActiveLockCount()).toBe(before);
  });
});
