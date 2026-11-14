import { NextResponse } from "next/server";
import {
  hashPassword,
  isDevMode,
  isSetupComplete,
  setAdminPasswordHash,
  verifyApiToken,
} from "@/lib/auth";
import { getDemoModeBlockedMessage, isDemoMode } from "@/lib/demo-mode";
import { checkSetupToken, getConfiguredSetupToken } from "@/lib/setup-token";

export async function GET() {
  const setupComplete = await isSetupComplete();
  // Only reveal whether a token is needed, never the token itself.
  const tokenRequired = !setupComplete && getConfiguredSetupToken() !== null;
  return NextResponse.json({ setupComplete, tokenRequired });
}

// A valid API key (X-Frost-Token) also authorizes setup: API keys are only
// minted on the server (install.sh --create-api-key, cleanup key) and already
// grant full admin access, so they prove the same server access as the setup
// token. Lets non-interactive tooling (e2e, demo provisioning) finish setup.
async function hasValidApiKey(request: Request): Promise<boolean> {
  const apiKey = request.headers.get("x-frost-token");
  if (!apiKey) return false;
  return verifyApiToken(apiKey);
}

export async function POST(request: Request) {
  if (isDemoMode()) {
    return NextResponse.json(
      { error: getDemoModeBlockedMessage("setup changes") },
      { status: 400 },
    );
  }

  // Checked before the token: once setup is complete the token is useless.
  if (await isSetupComplete()) {
    return NextResponse.json(
      { error: "setup already complete" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => null);
  const password = body?.password;

  const tokenCheck = checkSetupToken(body?.token, getConfiguredSetupToken());
  if (tokenCheck === "invalid" && !(await hasValidApiKey(request))) {
    return NextResponse.json(
      { error: "invalid or missing setup token" },
      { status: 403 },
    );
  }
  if (tokenCheck === "not-configured" && !isDevMode()) {
    console.warn(
      "[setup] FROST_SETUP_TOKEN is not set; initial setup is unprotected. Set FROST_SETUP_TOKEN in .env to require a setup token.",
    );
  }

  if (!password || typeof password !== "string") {
    return NextResponse.json(
      { error: "password is required" },
      { status: 400 },
    );
  }

  if (password.length < 12) {
    return NextResponse.json(
      { error: "password must be at least 12 characters" },
      { status: 400 },
    );
  }

  await setAdminPasswordHash(await hashPassword(password));

  return NextResponse.json({ success: true });
}
