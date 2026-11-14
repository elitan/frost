import { describe, expect, test } from "bun:test";
import {
  getClientIp,
  isSafeMethod,
  isSameOriginRequest,
} from "./request-utils";

function req(headers: Record<string, string>, url = "http://frost.test/api/x") {
  return new Request(url, { method: "POST", headers });
}

describe("getClientIp", () => {
  test("uses the last x-forwarded-for hop and ignores x-real-ip", () => {
    expect(
      getClientIp(
        req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4", "x-real-ip": "9.9.9.9" }),
      ),
    ).toBe("1.2.3.4");
    expect(getClientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("unknown");
  });
});

describe("isSameOriginRequest", () => {
  test("accepts sec-fetch-site same-origin", () => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(
      true,
    );
  });

  test("rejects cross-site sec-fetch-site even with matching origin", () => {
    expect(
      isSameOriginRequest(
        req({
          "sec-fetch-site": "cross-site",
          origin: "http://frost.test",
          host: "frost.test",
        }),
      ),
    ).toBe(false);
  });

  test("compares origin host to host header", () => {
    expect(
      isSameOriginRequest(
        req({ origin: "https://frost.example.com", host: "frost.example.com" }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        req({ origin: "https://evil.com", host: "frost.example.com" }),
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(req({ origin: "null", host: "frost.test" })),
    ).toBe(false);
  });

  test("rejects requests with no origin signal", () => {
    expect(isSameOriginRequest(req({}))).toBe(false);
  });

  test("safe methods", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("head")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
  });
});
