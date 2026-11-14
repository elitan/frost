import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDemoModeBlockedMessage, isDemoMode } from "@/lib/demo-mode";
import { newOauthClientId } from "@/lib/id";
import { isValidRedirectUri } from "@/lib/oauth";
import { getClientIp } from "@/lib/request-utils";

const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_MAX_REQUESTS = 20;
const REGISTER_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_GLOBAL_MAX = 100;
const REGISTER_MAX_TRACKED_IPS = 10_000;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 120;

type RegisterLimitState = {
  ips: Map<string, { count: number; resetAt: number }>;
  global: { count: number; resetAt: number };
};

const g = globalThis as typeof globalThis & {
  __oauthRegisterLimitState?: RegisterLimitState;
};
if (!g.__oauthRegisterLimitState) {
  g.__oauthRegisterLimitState = {
    ips: new Map(),
    global: { count: 0, resetAt: 0 },
  };
}
const registerLimit = g.__oauthRegisterLimitState;

export async function POST(request: Request) {
  if (isDemoMode()) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: getDemoModeBlockedMessage("oauth registration"),
      },
      { status: 400 },
    );
  }

  const clientAddress = getClientIp(request);
  if (isRateLimited(clientAddress)) {
    return NextResponse.json(
      {
        error: "slow_down",
        error_description: "Too many registration requests",
      },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const clientName =
    typeof body.client_name === "string" ? body.client_name : null;
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  const uniqueRedirectUris = [...new Set(redirectUris)];

  if (clientName && clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: "client_name too long",
      },
      { status: 400 },
    );
  }

  if (uniqueRedirectUris.length === 0) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: "redirect_uris required",
      },
      { status: 400 },
    );
  }

  if (uniqueRedirectUris.length > MAX_REDIRECT_URIS) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: "too many redirect_uris",
      },
      { status: 400 },
    );
  }

  if (!uniqueRedirectUris.every(isValidRedirectUri)) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description:
          "redirect_uris must be https URLs (http allowed only for localhost)",
      },
      { status: 400 },
    );
  }

  try {
    await deleteStaleClients();
  } catch (error) {
    console.error("failed to delete stale oauth clients", error);
  }

  const id = newOauthClientId();
  const clientId = `frost_client_${randomBytes(16).toString("hex")}`;

  await db
    .insertInto("oauthClients")
    .values({
      id,
      clientId,
      clientName,
      redirectUris: JSON.stringify(uniqueRedirectUris),
    })
    .execute();

  return NextResponse.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: uniqueRedirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}

function isRateLimited(clientAddress: string): boolean {
  const now = Date.now();

  const global = registerLimit.global;
  if (global.resetAt <= now) {
    global.count = 0;
    global.resetAt = now + REGISTER_GLOBAL_WINDOW_MS;
  }
  if (global.count >= REGISTER_GLOBAL_MAX) return true;

  const entry = registerLimit.ips.get(clientAddress);
  if (entry && entry.resetAt > now) {
    if (entry.count >= REGISTER_MAX_REQUESTS) return true;
    entry.count += 1;
  } else {
    if (registerLimit.ips.size >= REGISTER_MAX_TRACKED_IPS) {
      pruneRateLimitEntries(now);
    }
    registerLimit.ips.set(clientAddress, {
      count: 1,
      resetAt: now + REGISTER_WINDOW_MS,
    });
  }

  global.count += 1;
  return false;
}

function pruneRateLimitEntries(now: number): void {
  for (const [address, entry] of registerLimit.ips) {
    if (entry.resetAt <= now) registerLimit.ips.delete(address);
  }
  let excess = registerLimit.ips.size - REGISTER_MAX_TRACKED_IPS + 1;
  for (const address of registerLimit.ips.keys()) {
    if (excess <= 0) break;
    registerLimit.ips.delete(address);
    excess -= 1;
  }
}

// Dynamic registration is unauthenticated, so drop abandoned clients: older
// than 24h with no tokens and no pending codes.
async function deleteStaleClients(): Promise<void> {
  await db
    .deleteFrom("oauthClients")
    .where("createdAt", "<", sql<string>`datetime('now', '-1 day')`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("oauthTokens")
            .select("oauthTokens.id")
            .whereRef("oauthTokens.clientId", "=", "oauthClients.clientId"),
        ),
      ),
    )
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("oauthCodes")
            .select("oauthCodes.id")
            .whereRef("oauthCodes.clientId", "=", "oauthClients.clientId")
            .where("oauthCodes.expiresAt", ">", new Date().toISOString()),
        ),
      ),
    )
    .execute();
}
