import type { PortBinding } from "./docker";

export interface ServicePortBindingDomain {
  type: "proxy" | "redirect" | null;
  dnsVerified: boolean | null;
  isSystem: boolean | null;
}

export interface ServicePortBindingInput {
  serviceType: "app" | "database" | "object-storage" | null;
  domains: ServicePortBindingDomain[];
  /**
   * For object storage runtimes: whether an object storage row exists and the
   * S3 endpoint it advertises is a domain (true) or the raw
   * http://<server-ip>:<port> (false). Ignored for other service types.
   */
  objectStorage?: { hasExternalEndpoint: boolean } | null;
}

/**
 * A service's host port only needs to be reachable from the host when Caddy
 * serves it through a proxy domain (verified, or a system wildcard domain).
 * Without one, users reach the service at <server-ip>:<host-port>, so keep
 * publishing it on all interfaces.
 */
export function isServedViaDomain(
  domains: ServicePortBindingDomain[],
): boolean {
  return domains.some(function isRoutedProxyDomain(domain) {
    return (
      domain.type === "proxy" &&
      (domain.dnsVerified === true || domain.isSystem === true)
    );
  });
}

export function decideServicePortBinding(
  input: ServicePortBindingInput,
): PortBinding {
  if (input.serviceType === "object-storage" && input.objectStorage) {
    return input.objectStorage.hasExternalEndpoint ? "loopback" : "all";
  }
  return isServedViaDomain(input.domains) ? "loopback" : "all";
}

export function describeServicePortBinding(binding: PortBinding): string {
  return binding === "loopback"
    ? "Port bound to 127.0.0.1 (served via domain)\n"
    : "Port published publicly (no domain configured)\n";
}
