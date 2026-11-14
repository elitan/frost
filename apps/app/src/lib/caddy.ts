const CADDY_ADMIN = "http://localhost:2019";
const ACME_STAGING_CA =
  "https://acme-staging-v02.api.letsencrypt.org/directory";

export function acmeIssuer(email: string, staging: boolean) {
  return staging
    ? { module: "acme", email, ca: ACME_STAGING_CA }
    : { module: "acme", email };
}

export type DnsProvider = "cloudflare";

export interface DnsConfig {
  provider: DnsProvider;
  apiToken: string;
}

export function dnsAcmeIssuer(
  email: string,
  dnsConfig: DnsConfig,
  staging: boolean,
) {
  const base: Record<string, unknown> = {
    module: "acme",
    email,
    challenges: {
      dns: {
        provider: {
          name: dnsConfig.provider,
          api_token: dnsConfig.apiToken,
        },
      },
    },
  };

  if (staging) {
    base.ca = ACME_STAGING_CA;
  }

  return base;
}

export async function isCaddyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${CADDY_ADMIN}/config/`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getCurrentConfig(): Promise<unknown> {
  const res = await fetch(`${CADDY_ADMIN}/config/`);
  if (!res.ok) throw new Error("Failed to get Caddy config");
  return res.json();
}
