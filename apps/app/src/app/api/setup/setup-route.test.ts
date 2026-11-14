import { afterEach, describe, expect, mock, test } from "bun:test";

const state = {
  setupComplete: false,
  savedHash: null as string | null,
  validApiKeys: new Set<string>(),
  demo: false,
};

const env = process.env as Record<string, string | undefined>;
const originalToken = env.FROST_SETUP_TOKEN;
const originalNodeEnv = env.NODE_ENV;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

afterEach(() => {
  state.setupComplete = false;
  state.savedHash = null;
  state.validApiKeys.clear();
  state.demo = false;
  restoreEnv("FROST_SETUP_TOKEN", originalToken);
  restoreEnv("NODE_ENV", originalNodeEnv);
});

mock.module("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

mock.module("@/lib/auth", () => ({
  hashPassword: async (password: string) => `hashed:${password}`,
  isDevMode: () => process.env.NODE_ENV === "development",
  isSetupComplete: async () => state.setupComplete,
  setAdminPasswordHash: async (hash: string) => {
    state.savedHash = hash;
    state.setupComplete = true;
  },
  verifyApiToken: async (token: string) => state.validApiKeys.has(token),
}));

mock.module("@/lib/demo-mode", () => ({
  getDemoModeBlockedMessage: (target: string) => `${target} disabled`,
  isDemoMode: () => state.demo,
}));

type Result = { body: Record<string, unknown>; status: number };

async function post(
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Result> {
  const { POST } = await import("./route");
  return (await POST(
    new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )) as unknown as Result;
}

async function get(): Promise<Result> {
  const { GET } = await import("./route");
  return (await GET()) as unknown as Result;
}

const PASSWORD = "a-strong-password-123";

describe("POST /api/setup with a configured token", () => {
  test("rejects a missing token", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    const res = await post({ password: PASSWORD });
    expect(res.status).toBe(403);
    expect(state.savedHash).toBeNull();
  });

  test("rejects a wrong token", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    const res = await post({ password: PASSWORD, token: "tok-124" });
    expect(res.status).toBe(403);
    expect(state.savedHash).toBeNull();
  });

  test("requires the token even in development", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    env.NODE_ENV = "development";
    const res = await post({ password: PASSWORD });
    expect(res.status).toBe(403);
  });

  test("accepts the correct token", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    const res = await post({ password: PASSWORD, token: "tok-123" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(state.savedHash).toBe(`hashed:${PASSWORD}`);
  });

  test("accepts a valid API key instead of the token", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    state.validApiKeys.add("frost_key");
    const res = await post(
      { password: PASSWORD },
      { "X-Frost-Token": "frost_key" },
    );
    expect(res.status).toBe(200);
  });

  test("rejects an invalid API key", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    const res = await post(
      { password: PASSWORD },
      { "X-Frost-Token": "frost_nope" },
    );
    expect(res.status).toBe(403);
  });

  test("refuses to run again after setup, even with the token", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    state.setupComplete = true;
    const res = await post({ password: PASSWORD, token: "tok-123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("setup already complete");
  });
});

describe("POST /api/setup without a configured token", () => {
  test("allows setup in development", async () => {
    delete env.FROST_SETUP_TOKEN;
    env.NODE_ENV = "development";
    const res = await post({ password: PASSWORD });
    expect(res.status).toBe(200);
  });

  test("allows setup in production for legacy installs", async () => {
    delete env.FROST_SETUP_TOKEN;
    env.NODE_ENV = "production";
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const res = await post({ password: PASSWORD });
      expect(res.status).toBe(200);
    } finally {
      console.warn = warn;
    }
    expect(warnings.length).toBe(1);
  });
});

describe("GET /api/setup", () => {
  test("reports tokenRequired without revealing the token", async () => {
    env.FROST_SETUP_TOKEN = "tok-123";
    const res = await get();
    expect(res.body).toEqual({ setupComplete: false, tokenRequired: true });
    expect(JSON.stringify(res.body)).not.toContain("tok-123");
  });

  test("tokenRequired is false without a token or after setup", async () => {
    delete env.FROST_SETUP_TOKEN;
    expect((await get()).body.tokenRequired).toBe(false);
    env.FROST_SETUP_TOKEN = "tok-123";
    state.setupComplete = true;
    expect((await get()).body).toEqual({
      setupComplete: true,
      tokenRequired: false,
    });
  });
});
