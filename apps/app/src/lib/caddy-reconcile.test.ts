import { describe, expect, mock, test } from "bun:test";
import {
  caddyAppsHash,
  canonicalJson,
  isCaddyConfigDrifted,
  reconcileCaddyConfig,
} from "./caddy-reconcile";
import { buildCaddyConfig, type DesiredCaddyConfig } from "./domains";

function desiredConfig() {
  return buildCaddyConfig(
    [
      { domain: "frost.example.com", type: "frost-admin", hostPorts: [] },
      {
        domain: "app.example.com",
        type: "proxy",
        hostPorts: [8001, 8002],
        requestTimeout: 30,
      },
      {
        domain: "old.example.com",
        type: "redirect",
        hostPorts: [],
        redirectTarget: "app.example.com",
        redirectCode: 301,
      },
    ],
    "admin@example.com",
    false,
  );
}

// Simulates Caddy echoing the loaded config back from GET /config/:
// undefined fields dropped and keys re-ordered.
function asCaddyReturnsIt(config: unknown): unknown {
  const reverse = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) {
        out[key] = reverse((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return reverse(JSON.parse(JSON.stringify(config)));
}

describe("canonicalJson", () => {
  test("sorts keys recursively and drops undefined", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: undefined } }),
    ).toBe('{"a":{"d":[{"x":2,"y":1}]},"b":1}');
  });

  test("keeps array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  test("handles null/undefined", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("isCaddyConfigDrifted", () => {
  test("no drift when Caddy returns the same config re-encoded", () => {
    const desired = desiredConfig();
    expect(isCaddyConfigDrifted(desired, asCaddyReturnsIt(desired))).toBe(
      false,
    );
  });

  test("ignores top-level keys outside apps", () => {
    const desired = desiredConfig();
    const live = {
      ...(asCaddyReturnsIt(desired) as object),
      admin: { listen: "localhost:2019" },
    };
    expect(isCaddyConfigDrifted(desired, live)).toBe(false);
  });

  test("drift when Caddy lost its config", () => {
    expect(isCaddyConfigDrifted(desiredConfig(), null)).toBe(true);
    expect(isCaddyConfigDrifted(desiredConfig(), {})).toBe(true);
  });

  test("drift when Caddy runs the install-time Caddyfile config", () => {
    const caddyfileConfig = {
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":443"],
              routes: [
                {
                  match: [{ host: ["1.2.3.4"] }],
                  handle: [
                    {
                      handler: "reverse_proxy",
                      upstreams: [{ dial: "localhost:3000" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
    expect(isCaddyConfigDrifted(desiredConfig(), caddyfileConfig)).toBe(true);
  });

  test("drift when a route changed", () => {
    const desired = desiredConfig();
    const live = JSON.parse(JSON.stringify(desired));
    live.apps.http.servers.https.routes[1].handle[0].upstreams = [
      { dial: "localhost:8001" },
    ];
    expect(isCaddyConfigDrifted(desired, live)).toBe(true);
  });

  test("hash is stable across key order", () => {
    const desired = desiredConfig();
    expect(caddyAppsHash(desired)).toBe(
      caddyAppsHash(asCaddyReturnsIt(desired)),
    );
  });
});

describe("reconcileCaddyConfig", () => {
  const desired: DesiredCaddyConfig = {
    config: desiredConfig(),
    serviceDomains: 2,
    staging: false,
  };

  test("skips when there is nothing to load", async () => {
    const sync = mock(async () => undefined);
    const fetchLive = mock(async () => null);
    const result = await reconcileCaddyConfig({
      computeDesired: async () => ({
        config: null,
        serviceDomains: 0,
        staging: false,
      }),
      fetchLive,
      sync,
    });
    expect(result).toBe("skipped");
    expect(fetchLive).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  test("reports unreachable when Caddy is down", async () => {
    const sync = mock(async () => undefined);
    const result = await reconcileCaddyConfig({
      computeDesired: async () => desired,
      fetchLive: async () => {
        throw new Error("ECONNREFUSED");
      },
      sync,
    });
    expect(result).toBe("unreachable");
    expect(sync).not.toHaveBeenCalled();
  });

  test("does nothing when in sync", async () => {
    const sync = mock(async () => undefined);
    const result = await reconcileCaddyConfig({
      computeDesired: async () => desired,
      fetchLive: async () => asCaddyReturnsIt(desired.config),
      sync,
    });
    expect(result).toBe("in-sync");
    expect(sync).not.toHaveBeenCalled();
  });

  test("re-syncs on drift", async () => {
    const sync = mock(async () => undefined);
    const result = await reconcileCaddyConfig({
      computeDesired: async () => desired,
      fetchLive: async () => null,
      sync,
    });
    expect(result).toBe("synced");
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
