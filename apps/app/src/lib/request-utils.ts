export function getRequestOrigin(request: Request): string {
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (request.url.startsWith("https") ? "https" : "http");
  const host = request.headers.get("host");
  if (host) {
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}

// Caddy appends the connecting peer address to X-Forwarded-For, so the last
// hop is the only one a client cannot forge. X-Real-IP is never trusted.
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return "unknown";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

// CSRF guard for cookie-authenticated requests: the browser must prove the
// request came from our own origin, via Sec-Fetch-Site or a matching Origin.
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    return fetchSite === "same-origin";
  }

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  const host = request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
