import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_SESSIONS = 100;

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

const g = globalThis as typeof globalThis & {
  __mcpSessionStore?: Map<string, McpSession>;
  __mcpSessionSweeper?: ReturnType<typeof setInterval>;
};
if (!g.__mcpSessionStore) {
  g.__mcpSessionStore = new Map();
}
const sessions = g.__mcpSessionStore;

function closeSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.transport.close().catch((err) => {
    console.error(`Failed to close MCP session ${id}:`, err);
  });
}

function sweepIdleSessions(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_IDLE_TIMEOUT_MS) {
      closeSession(id);
    }
  }
}

function evictOldestSessions(): void {
  while (sessions.size >= MAX_SESSIONS) {
    let oldestId: string | null = null;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [id, session] of sessions) {
      if (session.lastSeen < oldestSeen) {
        oldestSeen = session.lastSeen;
        oldestId = id;
      }
    }
    if (!oldestId) return;
    closeSession(oldestId);
  }
}

if (!g.__mcpSessionSweeper) {
  g.__mcpSessionSweeper = setInterval(
    () => sweepIdleSessions(),
    SESSION_SWEEP_INTERVAL_MS,
  );
  g.__mcpSessionSweeper.unref?.();
}

function createTransport(): WebStandardStreamableHTTPServerTransport {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized(id) {
      sweepIdleSessions();
      evictOldestSessions();
      sessions.set(id, { transport, lastSeen: Date.now() });
    },
    onsessionclosed(id) {
      sessions.delete(id);
    },
  });
  return transport;
}

async function handleRequest(request: Request): Promise<Response> {
  const sessionId = request.headers.get("mcp-session-id");

  if (request.method === "DELETE") {
    if (!sessionId) return new Response(null, { status: 404 });
    const session = sessions.get(sessionId);
    if (!session) return new Response(null, { status: 404 });
    sessions.delete(sessionId);
    await session.transport.close();
    return new Response(null, { status: 200 });
  }

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (!existing) return new Response(null, { status: 404 });
    if (Date.now() - existing.lastSeen > SESSION_IDLE_TIMEOUT_MS) {
      closeSession(sessionId);
      return new Response(null, { status: 404 });
    }
    existing.lastSeen = Date.now();
    return existing.transport.handleRequest(request);
  }

  const transport = createTransport();
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handleRequest;
export const POST = handleRequest;
export const DELETE = handleRequest;
