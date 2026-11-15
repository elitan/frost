import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  getServiceWakePort,
  SERVICE_WAKE_HEADER,
} from "./scale-to-zero-config";
import {
  ensureServiceAwake as ensureServiceAwakeDefault,
  trackProxyConnection,
} from "./service-scale-to-zero";

/**
 * HTTP server that Caddy routes a sleeping service's domains to (see
 * buildCaddyConfig). It wakes the service, holds the request until the
 * service is healthy, then proxies it. Once awake, Caddy is switched back to
 * the service's own ports, so only the first requests pass through here.
 *
 * Binds to 127.0.0.1 only: Caddy runs on the host, and the wake header must
 * not be settable from outside.
 */

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

export interface WakeServerOptions {
  ensureServiceAwake?: (serviceId: string) => Promise<number[]>;
}

function getWakeServiceId(headers: IncomingHttpHeaders): string | null {
  const value = headers[SERVICE_WAKE_HEADER];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (key === SERVICE_WAKE_HEADER) continue;
    if (HOP_BY_HOP_HEADERS.has(key) && key !== "transfer-encoding") continue;
    result[key] = value;
  }
  return result;
}

function buildDownstreamHeaders(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

function sendUnavailable(res: ServerResponse, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    "retry-after": "5",
    "cache-control": "no-store",
  });
  res.end(`${message}\n`);
}

function pickPort(ports: number[], counter: { value: number }): number {
  const port = ports[counter.value % ports.length];
  counter.value += 1;
  return port;
}

export function createServiceWakeServer(
  options: WakeServerOptions = {},
): Server {
  const ensureServiceAwake =
    options.ensureServiceAwake ?? ensureServiceAwakeDefault;
  const counter = { value: 0 };

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const serviceId = getWakeServiceId(req.headers);
    if (!serviceId) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Unknown service\n");
      return;
    }

    const release = trackProxyConnection(serviceId);
    res.on("close", release);

    let ports: number[];
    try {
      ports = await ensureServiceAwake(serviceId);
    } catch (error) {
      console.error("[wake-server] Failed to wake service", {
        serviceId,
        error,
      });
      sendUnavailable(res, "Service is unavailable. Try again shortly.");
      return;
    }
    if (ports.length === 0 || res.destroyed) {
      sendUnavailable(res, "Service is unavailable. Try again shortly.");
      return;
    }

    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: pickPort(ports, counter),
        method: req.method,
        path: req.url,
        headers: buildUpstreamHeaders(req.headers),
      },
      function onUpstreamResponse(upstreamRes) {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          buildDownstreamHeaders(upstreamRes.headers),
        );
        upstreamRes.pipe(res);
        upstreamRes.on("error", function onUpstreamResponseError() {
          res.destroy();
        });
      },
    );
    upstream.on("error", function onUpstreamError(error) {
      console.error("[wake-server] Upstream request failed", {
        serviceId,
        error,
      });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad gateway\n");
    });
    res.on("close", function onClientClose() {
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });
    req.pipe(upstream);
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const serviceId = getWakeServiceId(req.headers);
    if (!serviceId) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    const release = trackProxyConnection(serviceId);
    socket.on("close", release);
    // Node drops its own error listener from upgraded sockets, so a client
    // reset while the service wakes would otherwise crash the process.
    socket.on("error", function onEarlySocketError() {
      socket.destroy();
    });

    let ports: number[];
    try {
      ports = await ensureServiceAwake(serviceId);
    } catch (error) {
      console.error("[wake-server] Failed to wake service", {
        serviceId,
        error,
      });
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    if (ports.length === 0 || socket.destroyed) {
      socket.destroy();
      return;
    }

    const upstream: Socket = connect(pickPort(ports, counter), "127.0.0.1");
    upstream.on("connect", function onConnect() {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (name.toLowerCase() === SERVICE_WAKE_HEADER) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", function onUpstreamError() {
      socket.destroy();
    });
    socket.on("error", function onSocketError() {
      upstream.destroy();
    });
    upstream.on("close", function onUpstreamClose() {
      socket.destroy();
    });
    socket.on("close", function onSocketClose() {
      upstream.destroy();
    });
  }

  const server = createServer(function onRequest(req, res) {
    handleRequest(req, res).catch(function onError(error) {
      console.error("[wake-server] Request handling failed", error);
      sendUnavailable(res, "Service is unavailable. Try again shortly.");
    });
  });
  server.on("upgrade", function onUpgrade(req, socket, head) {
    handleUpgrade(req, socket, head).catch(function onError(error) {
      console.error("[wake-server] Upgrade handling failed", error);
      socket.destroy();
    });
  });
  // Cold starts can take a while; don't let Node time the request out.
  server.requestTimeout = 0;
  return server;
}

const globalForWakeServer = globalThis as typeof globalThis & {
  frostServiceWakeServer?: Server;
};

export function startServiceWakeServer(): Promise<number> {
  const port = getServiceWakePort();
  if (globalForWakeServer.frostServiceWakeServer) {
    return Promise.resolve(port);
  }
  const server = createServiceWakeServer();
  globalForWakeServer.frostServiceWakeServer = server;
  return new Promise(function listen(resolve, reject) {
    server.once("error", function onError(error) {
      globalForWakeServer.frostServiceWakeServer = undefined;
      reject(error);
    });
    server.listen(port, "127.0.0.1", function onListening() {
      resolve(port);
    });
  });
}
