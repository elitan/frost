import { afterEach, describe, expect, test } from "bun:test";
import {
  getTrackedIpCount,
  LOGIN_RATE_LIMITS,
  recordLoginSuccess,
  reserveLoginAttempt,
  resetLoginRateLimit,
} from "./login-rate-limit";

afterEach(() => {
  resetLoginRateLimit();
});

describe("login rate limit", () => {
  test("blocks an ip after max failures and resets after the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIpMaxFailures; i++) {
      expect(reserveLoginAttempt("1.1.1.1", now).allowed).toBe(true);
    }
    const blocked = reserveLoginAttempt("1.1.1.1", now);
    expect(blocked.allowed).toBe(false);
    expect(reserveLoginAttempt("2.2.2.2", now).allowed).toBe(true);
    expect(
      reserveLoginAttempt("1.1.1.1", now + LOGIN_RATE_LIMITS.perIpWindowMs)
        .allowed,
    ).toBe(true);
  });

  test("applies global cap with backoff across ips", () => {
    const now = 5_000_000;
    for (let i = 0; i < LOGIN_RATE_LIMITS.globalMaxFailures; i++) {
      expect(reserveLoginAttempt(`10.0.${i}.1`, now).allowed).toBe(true);
    }
    const blocked = reserveLoginAttempt("10.9.9.9", now + 1000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
    const later = now + LOGIN_RATE_LIMITS.globalBackoffBaseMs;
    expect(reserveLoginAttempt("10.9.9.9", later).allowed).toBe(true);
    expect(reserveLoginAttempt("10.9.9.8", later + 1000).allowed).toBe(false);
    expect(
      reserveLoginAttempt("10.9.9.8", now + LOGIN_RATE_LIMITS.globalWindowMs)
        .allowed,
    ).toBe(true);
  });

  test("success refunds the reservation", () => {
    const now = 9_000_000;
    for (let i = 0; i < LOGIN_RATE_LIMITS.perIpMaxFailures; i++) {
      reserveLoginAttempt("3.3.3.3", now);
    }
    recordLoginSuccess("3.3.3.3");
    expect(reserveLoginAttempt("3.3.3.3", now).allowed).toBe(true);
  });

  test("tracked ip map stays bounded", () => {
    const now = 20_000_000;
    for (let i = 0; i < LOGIN_RATE_LIMITS.maxTrackedIps + 50; i++) {
      reserveLoginAttempt(
        `ip-${i}`,
        now + i * LOGIN_RATE_LIMITS.globalWindowMs,
      );
    }
    expect(getTrackedIpCount()).toBeLessThanOrEqual(
      LOGIN_RATE_LIMITS.maxTrackedIps,
    );
  });
});
