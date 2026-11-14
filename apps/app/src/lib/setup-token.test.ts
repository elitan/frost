import { afterEach, describe, expect, test } from "bun:test";
import {
  checkSetupToken,
  getConfiguredSetupToken,
  setupTokensMatch,
} from "./setup-token";

const ORIGINAL = process.env.FROST_SETUP_TOKEN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FROST_SETUP_TOKEN;
  else process.env.FROST_SETUP_TOKEN = ORIGINAL;
});

describe("getConfiguredSetupToken", () => {
  test("returns null when unset or blank", () => {
    delete process.env.FROST_SETUP_TOKEN;
    expect(getConfiguredSetupToken()).toBeNull();
    process.env.FROST_SETUP_TOKEN = "   ";
    expect(getConfiguredSetupToken()).toBeNull();
  });

  test("returns trimmed token", () => {
    process.env.FROST_SETUP_TOKEN = " abc123 \n";
    expect(getConfiguredSetupToken()).toBe("abc123");
  });
});

describe("setupTokensMatch", () => {
  test("matches equal tokens and rejects different ones", () => {
    expect(setupTokensMatch("deadbeef", "deadbeef")).toBe(true);
    expect(setupTokensMatch("deadbeee", "deadbeef")).toBe(false);
    expect(setupTokensMatch("dead", "deadbeef")).toBe(false);
    expect(setupTokensMatch("", "deadbeef")).toBe(false);
  });
});

describe("checkSetupToken", () => {
  test("not-configured when no token is set", () => {
    expect(checkSetupToken(undefined, null)).toBe("not-configured");
    expect(checkSetupToken("anything", null)).toBe("not-configured");
  });

  test("valid only for the exact token", () => {
    expect(checkSetupToken("s3cret", "s3cret")).toBe("valid");
    expect(checkSetupToken(" s3cret ", "s3cret")).toBe("valid");
    expect(checkSetupToken("S3CRET", "s3cret")).toBe("invalid");
    expect(checkSetupToken("s3cret-x", "s3cret")).toBe("invalid");
  });

  test("invalid for missing or non-string tokens", () => {
    expect(checkSetupToken(undefined, "s3cret")).toBe("invalid");
    expect(checkSetupToken(null, "s3cret")).toBe("invalid");
    expect(checkSetupToken("", "s3cret")).toBe("invalid");
    expect(checkSetupToken(123, "s3cret")).toBe("invalid");
    expect(checkSetupToken({ token: "s3cret" }, "s3cret")).toBe("invalid");
  });
});
