import { createHash } from "node:crypto";
import {
  computeDesiredCaddyConfig,
  type DesiredCaddyConfig,
  syncCaddyConfig,
} from "./domains";

const CADDY_ADMIN = "http://localhost:2019";
const CHECK_INTERVAL_MS = 5 * 60_000;
// While Caddy is unreachable (restarting/upgrading), check again soon so
// routes come back quickly once it is up.
const UNREACHABLE_RETRY_MS = 15_000;

/**
 * Serializes a JSON value with object keys sorted recursively, dropping
 * `undefined` the same way JSON.stringify does. Caddy re-encodes the loaded
 * config with its own key order, so a plain JSON.stringify comparison would
 * report false drift.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value ?? null))));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Hash of the part of a Caddy config Frost owns (`apps`). Other top-level
 * keys (admin, logging, storage) are left to Caddy defaults by Frost and are
 * ignored so Caddy-side additions there do not trigger resyncs.
 */
export function caddyAppsHash(config: unknown): string {
  const apps =
    config && typeof config === "object"
      ? (config as { apps?: unknown }).apps
      : undefined;
  return createHash("sha256")
    .update(canonicalJson(apps ?? null))
    .digest("hex");
}

export function isCaddyConfigDrifted(desired: unknown, live: unknown): boolean {
  return caddyAppsHash(desired) !== caddyAppsHash(live);
}

async function fetchLiveCaddyConfig(): Promise<unknown> {
  const res = await fetch(`${CADDY_ADMIN}/config/`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Caddy admin API returned ${res.status}`);
  return res.json();
}

export type CaddyReconcileResult =
  | "skipped"
  | "unreachable"
  | "in-sync"
  | "synced";

export interface CaddyReconcileDeps {
  computeDesired?: () => Promise<DesiredCaddyConfig>;
  fetchLive?: () => Promise<unknown>;
  sync?: () => Promise<unknown>;
}

/**
 * Compares Caddy's live config with what Frost wants and re-syncs on
 * mismatch (e.g. Caddy restarted from the Caddyfile, or lost its config).
 * The sync itself re-reads the DB, so a concurrent sync landing between the
 * compare and the resync cannot leave a stale config behind.
 */
export async function reconcileCaddyConfig(
  deps: CaddyReconcileDeps = {},
): Promise<CaddyReconcileResult> {
  const desired = await (deps.computeDesired ?? computeDesiredCaddyConfig)();
  // Nothing to load (no email/domains): Caddy keeps the Caddyfile config.
  if (!desired.config) return "skipped";

  let live: unknown;
  try {
    live = await (deps.fetchLive ?? fetchLiveCaddyConfig)();
  } catch {
    return "unreachable";
  }

  if (!isCaddyConfigDrifted(desired.config, live)) return "in-sync";

  await (deps.sync ?? syncCaddyConfig)();
  return "synced";
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let tickInFlight = false;

function checkAndRun(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  reconcileCaddyConfig()
    .then((result) => {
      if (result === "synced") {
        console.log("[caddy-reconcile] config drift detected, re-synced");
      } else if (result === "unreachable" && !retryTimeout) {
        retryTimeout = setTimeout(() => {
          retryTimeout = null;
          checkAndRun();
        }, UNREACHABLE_RETRY_MS);
      }
    })
    .catch((error) => {
      console.error("[caddy-reconcile] Error:", error);
    })
    .finally(() => {
      tickInFlight = false;
    });
}

export function startCaddyReconcileScheduler(): boolean {
  if (process.env.NODE_ENV === "development") return false;
  if (intervalId) return true;
  intervalId = setInterval(checkAndRun, CHECK_INTERVAL_MS);
  // Startup already runs syncCaddyConfig; check once shortly after in case
  // Caddy was still starting (or restarted) when that ran.
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    checkAndRun();
  }, UNREACHABLE_RETRY_MS);
  return true;
}

export function stopCaddyReconcileScheduler(): void {
  if (intervalId) clearInterval(intervalId);
  if (retryTimeout) clearTimeout(retryTimeout);
  intervalId = null;
  retryTimeout = null;
}
