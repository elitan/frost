/**
 * In-process keyed async mutex.
 *
 * Tasks sharing a key run one at a time in FIFO order; tasks with different
 * keys run concurrently. A failing task never blocks the next one, and a key
 * is dropped from the map once its queue drains. The lock is not reentrant:
 * calling withLock for a key from inside a task holding that key deadlocks,
 * so lock-holding code must call unlocked internals instead.
 */
// On globalThis: Next.js loads instrumentation (schedulers, wake servers) and
// route handlers as separate module instances in one process; a module-level
// map would give each its own locks.
const globalForLocks = globalThis as typeof globalThis & {
  frostKeyedLockTails?: Map<string, Promise<void>>;
};
globalForLocks.frostKeyedLockTails ??= new Map<string, Promise<void>>();
const tails = globalForLocks.frostKeyedLockTails;

export async function withLock<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release = function noop(): void {};
  const current = new Promise<void>(function onCreate(resolve) {
    release = resolve;
  });
  const tail = previous.then(function onPrevious() {
    return current;
  });
  tails.set(key, tail);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  }
}

export function isLocked(key: string): boolean {
  return tails.has(key);
}

export function getActiveLockCount(): number {
  return tails.size;
}
