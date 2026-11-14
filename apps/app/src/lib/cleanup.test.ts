import { describe, expect, test } from "bun:test";
import { getImageGroupKey } from "./cleanup";

describe("getImageGroupKey", () => {
  test("groups legacy and new names by service label", () => {
    expect(getImageGroupKey("frost-proj1-api:abc", "svc_1")).toBe(
      "service:svc_1",
    );
    expect(getImageGroupKey("frost-svc-1:def", "svc_1")).toBe("service:svc_1");
  });

  test("falls back to repository name without label", () => {
    expect(getImageGroupKey("frost-proj1-api:abc", null)).toBe(
      "repo:frost-proj1-api",
    );
  });

  test("ignores non-frost images", () => {
    expect(getImageGroupKey("nginx:alpine", "svc_1")).toBeNull();
  });
});
