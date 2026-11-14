"use client";

import { useSyncExternalStore } from "react";

type Listener = () => void;

const SLOW_TICK_MS = 60_000;
const FAST_TICK_MS = 1_000;

const slowListeners = new Set<Listener>();
const fastListeners = new Set<Listener>();
let slowNow = Date.now();
let fastNow = Date.now();
let slowTimer: ReturnType<typeof setInterval> | null = null;
let fastTimer: ReturnType<typeof setInterval> | null = null;

function emit(listeners: Set<Listener>) {
  for (const listener of listeners) listener();
}

function subscribeSlow(listener: Listener) {
  slowListeners.add(listener);
  if (!slowTimer) {
    slowNow = Date.now();
    slowTimer = setInterval(function tickSlow() {
      slowNow = Date.now();
      emit(slowListeners);
    }, SLOW_TICK_MS);
  }
  return function unsubscribeSlow() {
    slowListeners.delete(listener);
    if (slowListeners.size === 0 && slowTimer) {
      clearInterval(slowTimer);
      slowTimer = null;
    }
  };
}

function subscribeFast(listener: Listener) {
  fastListeners.add(listener);
  if (!fastTimer) {
    fastNow = Date.now();
    fastTimer = setInterval(function tickFast() {
      fastNow = Date.now();
      emit(fastListeners);
    }, FAST_TICK_MS);
  }
  return function unsubscribeFast() {
    fastListeners.delete(listener);
    if (fastListeners.size === 0 && fastTimer) {
      clearInterval(fastTimer);
      fastTimer = null;
    }
  };
}

function getSlowSnapshot() {
  return slowNow;
}

function getFastSnapshot() {
  return fastNow;
}

function getServerSnapshot() {
  return 0;
}

/**
 * Shared ticking clock. All consumers share one interval per resolution, so
 * rendering many relative timestamps costs a single timer.
 * Returns 0 during SSR so callers can avoid hydration mismatches.
 */
export function useNow(resolution: "minute" | "second" = "minute"): number {
  const fast = resolution === "second";
  return useSyncExternalStore(
    fast ? subscribeFast : subscribeSlow,
    fast ? getFastSnapshot : getSlowSnapshot,
    getServerSnapshot,
  );
}
