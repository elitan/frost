import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { SERVICE_WAKE_HEADER } from "./scale-to-zero-config";
import {
  getActiveProxyConnections,
  resetScaleToZeroStateForTests,
} from "./service-scale-to-zero";
import { createServiceWakeServer } from "./service-wake-server";

const servers: Server[] = [];
const sockets = new Set<Socket>();

function listen(server: Server): Promise<number> {
  servers.push(server);
  // Upgraded sockets aren't closed by closeAllConnections; track them all.
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no address");
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  resetScaleToZeroStateForTests();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

async function startUpstream(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(201, {
        "content-type": "text/plain",
        "set-cookie": ["a=1", "b=2"],
        "x-upstream": "yes",
      });
      res.end(`hello from upstream ${req.url}`);
    });
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: "",
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (data: Buffer) => {
      socket.write(`echo:${data.toString()}`);
    });
  });
  const port = await listen(upstream);
  return { port, seen };
}

describe("service wake server", () => {
  test("wakes the service and proxies the request with its body", async () => {
    const upstream = await startUpstream();
    const wakeCalls: string[] = [];
    const wake = createServiceWakeServer({
      ensureServiceAwake: async (serviceId) => {
        wakeCalls.push(serviceId);
        await new Promise((r) => setTimeout(r, 50));
        return [upstream.port];
      },
    });
    const wakePort = await listen(wake);

    const response = await fetch(`http://127.0.0.1:${wakePort}/api/items?x=1`, {
      method: "POST",
      headers: {
        [SERVICE_WAKE_HEADER]: "svc-1",
        host: "app.example.com",
        "x-forwarded-for": "203.0.113.9",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "frost" }),
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("hello from upstream /api/items?x=1");
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(wakeCalls).toEqual(["svc-1"]);

    const [request] = upstream.seen;
    expect(request.method).toBe("POST");
    expect(request.body).toBe('{"name":"frost"}');
    expect(request.headers.host).toBe("app.example.com");
    expect(request.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(request.headers[SERVICE_WAKE_HEADER]).toBeUndefined();
  });

  test("rejects requests without the wake header", async () => {
    const wake = createServiceWakeServer({
      ensureServiceAwake: async () => {
        throw new Error("should not be called");
      },
    });
    const wakePort = await listen(wake);
    const response = await fetch(`http://127.0.0.1:${wakePort}/`);
    expect(response.status).toBe(404);
  });

  test("returns 503 with Retry-After when the service can't wake", async () => {
    const wake = createServiceWakeServer({
      ensureServiceAwake: async () => {
        throw new Error("health check failed");
      },
    });
    const wakePort = await listen(wake);
    const response = await fetch(`http://127.0.0.1:${wakePort}/`, {
      headers: { [SERVICE_WAKE_HEADER]: "svc-2" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  test("spreads requests over replicas", async () => {
    const first = await startUpstream();
    const second = await startUpstream();
    const wake = createServiceWakeServer({
      ensureServiceAwake: async () => [first.port, second.port],
    });
    const wakePort = await listen(wake);
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`http://127.0.0.1:${wakePort}/${i}`, {
        headers: { [SERVICE_WAKE_HEADER]: "svc-3" },
      });
      await response.text();
    }
    expect(first.seen).toHaveLength(2);
    expect(second.seen).toHaveLength(2);
  });

  test("counts in-flight requests so the service isn't put back to sleep", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = createServer(async (_req, res) => {
      await gate;
      res.end("done");
    });
    const upstreamPort = await listen(upstream);
    const wake = createServiceWakeServer({
      ensureServiceAwake: async () => [upstreamPort],
    });
    const wakePort = await listen(wake);

    const pending = fetch(`http://127.0.0.1:${wakePort}/slow`, {
      headers: { [SERVICE_WAKE_HEADER]: "svc-4" },
    });
    for (let i = 0; i < 50 && getActiveProxyConnections("svc-4") === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getActiveProxyConnections("svc-4")).toBe(1);
    release();
    const response = await pending;
    expect(await response.text()).toBe("done");
    for (let i = 0; i < 50 && getActiveProxyConnections("svc-4") > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getActiveProxyConnections("svc-4")).toBe(0);
  });

  test("proxies WebSocket upgrades after waking", async () => {
    const upstream = await startUpstream();
    const wake = createServiceWakeServer({
      ensureServiceAwake: async () => [upstream.port],
    });
    const wakePort = await listen(wake);

    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(wakePort, "127.0.0.1", () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            "Host: app.example.com",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `${SERVICE_WAKE_HEADER}: svc-5`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      let buffer = "";
      let sentPing = false;
      socket.on("data", (data: Buffer) => {
        buffer += data.toString();
        if (!sentPing && buffer.includes("\r\n\r\n")) {
          sentPing = true;
          socket.write("ping");
        }
        if (buffer.includes("echo:ping")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", reject);
    });

    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("echo:ping");
    const [upgrade] = upstream.seen;
    expect(upgrade.url).toBe("/ws");
    expect(upgrade.headers.host).toBe("app.example.com");
    expect(upgrade.headers[SERVICE_WAKE_HEADER]).toBeUndefined();
  });
});
