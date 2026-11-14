import { describe, expect, test } from "bun:test";
import {
  decideServicePortBinding,
  describeServicePortBinding,
  isServedViaDomain,
  type ServicePortBindingDomain,
} from "./service-port-binding";

const verifiedProxy: ServicePortBindingDomain = {
  type: "proxy",
  dnsVerified: true,
  isSystem: false,
};
const systemProxy: ServicePortBindingDomain = {
  type: "proxy",
  dnsVerified: false,
  isSystem: true,
};
const unverifiedProxy: ServicePortBindingDomain = {
  type: "proxy",
  dnsVerified: false,
  isSystem: false,
};
const verifiedRedirect: ServicePortBindingDomain = {
  type: "redirect",
  dnsVerified: true,
  isSystem: false,
};

describe("isServedViaDomain", function describeServedViaDomain() {
  test("verified or system proxy domains count", function testCounts() {
    expect(isServedViaDomain([verifiedProxy])).toBe(true);
    expect(isServedViaDomain([systemProxy])).toBe(true);
  });

  test("unverified and redirect-only domains do not count", function testIgnored() {
    expect(isServedViaDomain([])).toBe(false);
    expect(isServedViaDomain([unverifiedProxy])).toBe(false);
    expect(isServedViaDomain([verifiedRedirect])).toBe(false);
  });
});

describe("decideServicePortBinding", function describeDecide() {
  test("app with a routed domain binds loopback", function testAppDomain() {
    expect(
      decideServicePortBinding({
        serviceType: "app",
        domains: [unverifiedProxy, verifiedProxy],
      }),
    ).toBe("loopback");
  });

  test("app without a domain stays public", function testAppNoDomain() {
    expect(decideServicePortBinding({ serviceType: "app", domains: [] })).toBe(
      "all",
    );
    expect(
      decideServicePortBinding({
        serviceType: "app",
        domains: [unverifiedProxy],
      }),
    ).toBe("all");
  });

  test("object storage follows its advertised endpoint", function testObjectStorage() {
    expect(
      decideServicePortBinding({
        serviceType: "object-storage",
        domains: [systemProxy],
        objectStorage: { hasExternalEndpoint: false },
      }),
    ).toBe("all");
    expect(
      decideServicePortBinding({
        serviceType: "object-storage",
        domains: [],
        objectStorage: { hasExternalEndpoint: true },
      }),
    ).toBe("loopback");
  });

  test("object storage without a row falls back to domains", function testNoRow() {
    expect(
      decideServicePortBinding({
        serviceType: "object-storage",
        domains: [systemProxy],
        objectStorage: null,
      }),
    ).toBe("loopback");
  });
});

describe("describeServicePortBinding", function describeLog() {
  test("build log messages", function testMessages() {
    expect(describeServicePortBinding("loopback")).toBe(
      "Port bound to 127.0.0.1 (served via domain)\n",
    );
    expect(describeServicePortBinding("all")).toBe(
      "Port published publicly (no domain configured)\n",
    );
  });
});
