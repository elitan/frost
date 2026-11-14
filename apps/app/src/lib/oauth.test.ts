import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  generateAccessToken,
  generateCode,
  generateRefreshToken,
  getAccessTokenExpiry,
  getAccessTokenTtlSeconds,
  getRedirectHostLabel,
  hashOAuthToken,
  isValidRedirectUri,
  verifyPKCE,
} from "./oauth";

describe("oauth", () => {
  describe("generateCode", () => {
    test("produces 64 char hex string", () => {
      const code = generateCode();
      expect(code).toHaveLength(64);
      expect(code).toMatch(/^[a-f0-9]{64}$/);
    });

    test("produces unique values", () => {
      const a = generateCode();
      const b = generateCode();
      expect(a).not.toBe(b);
    });
  });

  describe("generateAccessToken", () => {
    test("has frost_at_ prefix", () => {
      const token = generateAccessToken();
      expect(token.startsWith("frost_at_")).toBe(true);
    });

    test("is long enough to be secure", () => {
      const token = generateAccessToken();
      expect(token.length).toBeGreaterThan(40);
    });
  });

  describe("generateRefreshToken", () => {
    test("has frost_rt_ prefix", () => {
      const token = generateRefreshToken();
      expect(token.startsWith("frost_rt_")).toBe(true);
    });
  });

  describe("access token ttl", () => {
    test("returns positive ttl seconds", () => {
      const ttlSeconds = getAccessTokenTtlSeconds();
      expect(ttlSeconds).toBeGreaterThan(0);
    });

    test("expiry is in the future", () => {
      const expiryMs = new Date(getAccessTokenExpiry()).getTime();
      expect(expiryMs).toBeGreaterThan(Date.now());
    });
  });

  describe("hashOAuthToken", () => {
    test("produces consistent hashes", () => {
      const token = "test-token-123";
      expect(hashOAuthToken(token)).toBe(hashOAuthToken(token));
    });

    test("different inputs produce different hashes", () => {
      expect(hashOAuthToken("token-a")).not.toBe(hashOAuthToken("token-b"));
    });

    test("produces hex string", () => {
      expect(hashOAuthToken("test")).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe("verifyPKCE", () => {
    test("returns true for valid S256 pair", () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      expect(verifyPKCE(verifier, challenge)).toBe(true);
    });

    test("returns false for wrong verifier", () => {
      const verifier = "correct-verifier";
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      expect(verifyPKCE("wrong-verifier", challenge)).toBe(false);
    });

    test("returns false for tampered challenge", () => {
      const verifier = "my-verifier";
      expect(verifyPKCE(verifier, "tampered-challenge")).toBe(false);
    });
  });

  describe("isValidRedirectUri", () => {
    test("allows https anywhere", () => {
      expect(
        isValidRedirectUri("https://claude.ai/api/mcp/auth_callback"),
      ).toBe(true);
    });

    test("allows http only for loopback hosts", () => {
      expect(isValidRedirectUri("http://localhost:9999/callback")).toBe(true);
      expect(isValidRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
      expect(isValidRedirectUri("http://[::1]:8080/cb")).toBe(true);
      expect(isValidRedirectUri("http://evil.example.com/cb")).toBe(false);
      expect(isValidRedirectUri("http://localhost.evil.com/cb")).toBe(false);
      expect(isValidRedirectUri("http://10.0.0.1/cb")).toBe(false);
    });

    test("rejects other schemes, fragments and credentials", () => {
      expect(isValidRedirectUri("javascript:alert(1)")).toBe(false);
      expect(isValidRedirectUri("ftp://example.com/cb")).toBe(false);
      expect(isValidRedirectUri("https://example.com/cb#frag")).toBe(false);
      expect(isValidRedirectUri("https://user:pw@example.com/cb")).toBe(false);
      expect(isValidRedirectUri("not a url")).toBe(false);
    });
  });

  describe("getRedirectHostLabel", () => {
    test("returns host with port", () => {
      expect(getRedirectHostLabel("https://evil.example.com:8443/cb")).toBe(
        "evil.example.com:8443",
      );
    });
  });
});
