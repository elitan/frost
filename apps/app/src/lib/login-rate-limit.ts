export const LOGIN_RATE_LIMITS = {
  perIpWindowMs: 60 * 1000,
  perIpMaxFailures: 10,
  globalWindowMs: 60 * 60 * 1000,
  globalMaxFailures: 100,
  globalBackoffBaseMs: 5 * 1000,
  globalBackoffMaxMs: 5 * 60 * 1000,
  maxTrackedIps: 10_000,
} as const;

type IpEntry = { count: number; resetAt: number };

type GlobalEntry = {
  count: number;
  resetAt: number;
  lastFailureAt: number;
};

type LoginRateLimitState = {
  ips: Map<string, IpEntry>;
  global: GlobalEntry;
};

const g = globalThis as typeof globalThis & {
  __loginRateLimit?: LoginRateLimitState;
};

function getState(): LoginRateLimitState {
  if (!g.__loginRateLimit) {
    g.__loginRateLimit = {
      ips: new Map(),
      global: { count: 0, resetAt: 0, lastFailureAt: 0 },
    };
  }
  return g.__loginRateLimit;
}

export function resetLoginRateLimit(): void {
  g.__loginRateLimit = undefined;
}

export type LoginRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function getGlobalBackoffMs(overCap: number): number {
  const exponent = Math.min(overCap, 16);
  return Math.min(
    LOGIN_RATE_LIMITS.globalBackoffBaseMs * 2 ** exponent,
    LOGIN_RATE_LIMITS.globalBackoffMaxMs,
  );
}

function toRetryAfter(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Reserves a login attempt slot. Call before verifying the password and then
 * call recordLoginSuccess() on success so the reservation is refunded. This
 * way concurrent attempts are counted before the (slow) password check.
 */
export function reserveLoginAttempt(
  clientIp: string,
  now = Date.now(),
): LoginRateLimitResult {
  const state = getState();

  const ipEntry = state.ips.get(clientIp);
  const ipActive = ipEntry && ipEntry.resetAt > now ? ipEntry : null;
  if (ipEntry && !ipActive) {
    state.ips.delete(clientIp);
  }
  if (ipActive && ipActive.count >= LOGIN_RATE_LIMITS.perIpMaxFailures) {
    return {
      allowed: false,
      retryAfterSeconds: toRetryAfter(ipActive.resetAt - now),
    };
  }

  const global = state.global;
  if (global.resetAt <= now) {
    global.count = 0;
    global.resetAt = now + LOGIN_RATE_LIMITS.globalWindowMs;
    global.lastFailureAt = 0;
  }
  if (global.count >= LOGIN_RATE_LIMITS.globalMaxFailures) {
    const backoff = getGlobalBackoffMs(
      global.count - LOGIN_RATE_LIMITS.globalMaxFailures,
    );
    const nextAllowedAt = Math.min(
      global.lastFailureAt + backoff,
      global.resetAt,
    );
    if (now < nextAllowedAt) {
      return {
        allowed: false,
        retryAfterSeconds: toRetryAfter(nextAllowedAt - now),
      };
    }
  }

  if (ipActive) {
    ipActive.count += 1;
  } else {
    if (state.ips.size >= LOGIN_RATE_LIMITS.maxTrackedIps) {
      pruneIps(state, now);
    }
    state.ips.set(clientIp, {
      count: 1,
      resetAt: now + LOGIN_RATE_LIMITS.perIpWindowMs,
    });
  }
  global.count += 1;
  global.lastFailureAt = now;

  return { allowed: true };
}

export function recordLoginSuccess(clientIp: string): void {
  const state = getState();
  state.ips.delete(clientIp);
  if (state.global.count > 0) {
    state.global.count -= 1;
  }
}

export function getTrackedIpCount(): number {
  return getState().ips.size;
}

function pruneIps(state: LoginRateLimitState, now: number): void {
  for (const [ip, entry] of state.ips) {
    if (entry.resetAt <= now) {
      state.ips.delete(ip);
    }
  }
  // Still full: drop the oldest entries (Map keeps insertion order).
  const excess = state.ips.size - LOGIN_RATE_LIMITS.maxTrackedIps + 1;
  if (excess <= 0) return;
  let removed = 0;
  for (const ip of state.ips.keys()) {
    if (removed >= excess) break;
    state.ips.delete(ip);
    removed += 1;
  }
}
