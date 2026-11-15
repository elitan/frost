import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import {
  activatorContainerName,
  activatorToken,
  createActivatorControlServer,
  isPrivateAddress,
  isValidActivatorToken,
} from "./service-activator";

describe("activator tokens", () => {
  test("are per service and verified in constant time", () => {
    const token = activatorToken("svc_a");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidActivatorToken("svc_a", token)).toBe(true);
    expect(isValidActivatorToken("svc_b", token)).toBe(false);
    expect(isValidActivatorToken("svc_a", "short")).toBe(false);
  });

  test("container names are docker-safe", () => {
    expect(activatorContainerName("svc_abc")).toBe("frost-activator-svc_abc");
  });
});

describe("isPrivateAddress", () => {
  test("accepts container and loopback sources only", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.18.0.5",
      "192.168.1.9",
      "::1",
      "::ffff:172.20.0.2",
      "fd00::1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of [
      "8.8.8.8",
      "172.32.0.1",
      "::ffff:1.2.3.4",
      "2001:db8::1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});

describe("activator control server", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((r) => server?.close(r));
    server = null;
  });

  async function start(): Promise<{ port: number; woken: string[] }> {
    const woken: string[] = [];
    server = createActivatorControlServer({
      ensureServiceAwake: async (serviceId) => {
        woken.push(serviceId);
        return [];
      },
      wakeDatabaseTarget: async (targetId) => {
        woken.push(`target:${targetId}`);
        return [`frost-db-${targetId}`];
      },
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    return { port, woken };
  }

  test("rejects unknown paths, wrong methods and bad tokens", async () => {
    const { port, woken } = await start();
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/nope`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/activate/svc_a`)).status).toBe(404);
    const forged = await fetch(`${base}/activate/svc_a`, {
      method: "POST",
      headers: { authorization: `Bearer ${activatorToken("svc_b")}` },
    });
    expect(forged.status).toBe(403);
    expect(woken).toEqual([]);
  });

  test("wakes the service for a valid token", async () => {
    const { port, woken } = await start();
    const response = await fetch(
      `http://127.0.0.1:${port}/activate/svc_missing`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${activatorToken("svc_missing")}` },
      },
    );
    // The service has no deployment in the test DB, so activation fails
    // after the wake was requested.
    expect(response.status).toBe(503);
    expect(woken).toEqual(["svc_missing"]);
  });

  test("wakes database targets with a target token only", async () => {
    const { port, woken } = await start();
    const url = `http://127.0.0.1:${port}/activate/target/dbt_1`;
    const withServiceToken = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${activatorToken("dbt_1")}` },
    });
    expect(withServiceToken.status).toBe(403);
    const onServiceRoute = await fetch(
      `http://127.0.0.1:${port}/activate/dbt_1`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${activatorToken("target:dbt_1")}` },
      },
    );
    expect(onServiceRoute.status).toBe(403);
    expect(woken).toEqual([]);

    const ok = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${activatorToken("target:dbt_1")}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-length")).toBe("15");
    expect(await ok.text()).toBe("frost-db-dbt_1\n");
    expect(woken).toEqual(["target:dbt_1"]);
  });
});
