import { createHash, timingSafeEqual } from "node:crypto";

// One-time setup token protecting POST /api/setup on fresh installs.
//
// install.sh generates a random token, writes it to /opt/frost/.env as
// FROST_SETUP_TOKEN and prints a setup URL (https://IP/setup?token=...).
// Only someone who can see the install output (or read .env on the server)
// can claim the instance.
//
// Policy when no token is configured:
// - development (`bun run dev`): allowed, no token needed.
// - production: allowed, but a warning is logged. This keeps existing
//   installs, docker images and manual installs (none of which have a token)
//   working. New installs via install.sh always get a token.
// If a token IS configured, it is required in every mode.
//
// Once setup completes the route refuses to run again, so the token stops
// being useful even though it stays in .env.

export type SetupTokenCheck = "valid" | "invalid" | "not-configured";

export function getConfiguredSetupToken(): string | null {
  const raw = process.env.FROST_SETUP_TOKEN;
  if (!raw) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function setupTokensMatch(provided: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length inputs and the
  // comparison does not leak the expected token length.
  return timingSafeEqual(digest(provided), digest(expected));
}

export function checkSetupToken(
  provided: unknown,
  configured: string | null,
): SetupTokenCheck {
  if (configured === null) return "not-configured";
  if (typeof provided !== "string" || provided.length === 0) return "invalid";
  return setupTokensMatch(provided.trim(), configured) ? "valid" : "invalid";
}
