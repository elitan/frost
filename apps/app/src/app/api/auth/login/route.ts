import { NextResponse } from "next/server";
import {
  createSessionToken,
  getAdminPasswordHash,
  isDevMode,
  isSetupComplete,
  verifyDevPassword,
  verifyPassword,
} from "@/lib/auth";
import { isDemoMode } from "@/lib/demo-mode";
import {
  recordLoginSuccess,
  reserveLoginAttempt,
} from "@/lib/login-rate-limit";
import { getClientIp } from "@/lib/request-utils";

export async function POST(request: Request) {
  const demoMode = isDemoMode();
  const clientAddress = getClientIp(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const password =
    body && typeof body === "object" && "password" in body
      ? body.password
      : undefined;

  if (!password || typeof password !== "string") {
    return NextResponse.json(
      { error: "password is required" },
      { status: 400 },
    );
  }

  const setupComplete = await isSetupComplete();
  if (!setupComplete) {
    return NextResponse.json({ error: "setup not complete" }, { status: 503 });
  }

  const limit = reserveLoginAttempt(clientAddress);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "too many attempts" },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  const hash = await getAdminPasswordHash();
  const validHash = hash && (await verifyPassword(password, hash));
  const validDev = isDevMode() && (await verifyDevPassword(password));

  if (!validHash && !validDev) {
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  recordLoginSuccess(clientAddress);

  const token = createSessionToken();
  const response = NextResponse.json({ success: true });
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isHttpsRequest =
    forwardedProto === "https" || request.url.startsWith("https://");
  const sameSite = demoMode ? "none" : "lax";

  response.cookies.set("frost_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development" && isHttpsRequest,
    sameSite,
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });

  return response;
}
