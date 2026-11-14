import { describe, expect, test } from "bun:test";
import { createSessionToken, safeEqual, verifySessionToken } from "./auth";

describe("auth", () => {
  test("safeEqual compares strings without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  test("verifySessionToken accepts valid and rejects tampered tokens", () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);

    const [data, signature] = token.split(".");
    expect(verifySessionToken(`${data}.${signature}x`)).toBe(false);
    expect(verifySessionToken(`${data}.${signature?.slice(0, -1)}`)).toBe(
      false,
    );
    expect(verifySessionToken(`${data}x.${signature}`)).toBe(false);
    expect(verifySessionToken("garbage")).toBe(false);
  });
});
