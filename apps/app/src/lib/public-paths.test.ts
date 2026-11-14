import { describe, expect, test } from "bun:test";
import { isPublicPath } from "./public-paths";

describe("public paths", () => {
  test("allows only explicit auth endpoints", () => {
    expect(isPublicPath("/api/auth/dev-info")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/auth/logout")).toBe(true);

    expect(isPublicPath("/api/auth/api-key")).toBe(false);
    expect(isPublicPath("/api/auth/future-route")).toBe(false);
  });

  test("has no public prefix routes", () => {
    expect(isPublicPath("/.well-known/oauth-authorization-server")).toBe(false);
    expect(isPublicPath("/api/oauth/token")).toBe(false);
    expect(isPublicPath("/api/mcp")).toBe(false);
    expect(isPublicPath("/api/docs")).toBe(false);
    expect(isPublicPath("/api/docs/anything")).toBe(false);
  });
});
