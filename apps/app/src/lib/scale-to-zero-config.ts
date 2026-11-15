// Shared by the API contract, the UI and frost.yaml validation, so this file
// must stay free of server-only imports.

export const SCALE_TO_ZERO_MIN_MINUTES = 1;
export const SCALE_TO_ZERO_MAX_MINUTES = 7 * 24 * 60;

/** Header Caddy sets on requests for a sleeping service's domains. */
export const SERVICE_WAKE_HEADER = "x-frost-wake-service";

export const DEFAULT_SERVICE_WAKE_PORT = 3090;

export function getServiceWakePort(): number {
  const raw = process.env.FROST_WAKE_PORT;
  if (!raw) {
    return DEFAULT_SERVICE_WAKE_PORT;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return DEFAULT_SERVICE_WAKE_PORT;
  }
  return port;
}
