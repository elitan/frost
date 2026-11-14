import https from "node:https";
import { ORPCError } from "@orpc/server";
import { getSetting } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeDomainName } from "@/lib/domain-validation";
import {
  addDomain,
  getDomain,
  getDomainByName,
  getDomainsForService,
  removeDomain,
  syncCaddyConfig,
  updateDomain,
  verifyDomainDns,
} from "@/lib/domains";
import { assertDemoWriteAllowed } from "./demo-guards";
import { os } from "./orpc";

function checkHttps(
  domain: string,
  rejectUnauthorized: boolean,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: domain,
        port: 443,
        method: "HEAD",
        timeout: 10000,
        rejectUnauthorized,
      },
      (res) => {
        resolve({ ok: (res.statusCode ?? 500) < 500, status: res.statusCode });
      },
    );

    req.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Connection timeout" });
    });

    req.end();
  });
}

async function assertNotFrostDomain(domain: string) {
  const frostDomain = await getSetting("domain");
  if (frostDomain && normalizeDomainName(frostDomain) === domain) {
    throw new ORPCError("CONFLICT", {
      message: "This domain is used by the Frost dashboard",
    });
  }
}

export const domains = {
  get: os.domains.get.handler(async ({ input }) => {
    const domain = await getDomain(input.id);
    if (!domain) {
      throw new ORPCError("NOT_FOUND", { message: "Domain not found" });
    }
    return domain;
  }),

  listByService: os.domains.listByService.handler(async ({ input }) => {
    const service = await db
      .selectFrom("services")
      .select("id")
      .where("id", "=", input.serviceId)
      .executeTakeFirst();

    if (!service) {
      throw new ORPCError("NOT_FOUND", { message: "Service not found" });
    }

    return getDomainsForService(input.serviceId);
  }),

  listByServiceIds: os.domains.listByServiceIds.handler(async ({ input }) => {
    if (input.serviceIds.length === 0) {
      return [];
    }
    return db
      .selectFrom("domains")
      .selectAll()
      .where("serviceId", "in", input.serviceIds)
      .execute();
  }),

  listByEnvironment: os.domains.listByEnvironment.handler(async ({ input }) => {
    return db
      .selectFrom("domains")
      .selectAll()
      .where("environmentId", "=", input.environmentId)
      .execute();
  }),

  create: os.domains.create.handler(async ({ input }) => {
    assertDemoWriteAllowed("domain changes");

    const service = await db
      .selectFrom("services")
      .select(["id", "environmentId"])
      .where("id", "=", input.serviceId)
      .executeTakeFirst();

    if (!service) {
      throw new ORPCError("NOT_FOUND", { message: "Service not found" });
    }

    const existing = await getDomainByName(input.domain);
    if (existing) {
      throw new ORPCError("CONFLICT", { message: "Domain already exists" });
    }

    await assertNotFrostDomain(input.domain);

    if (input.type === "redirect" && !input.redirectTarget) {
      throw new ORPCError("BAD_REQUEST", {
        message: "redirectTarget is required for redirect type",
      });
    }

    if (input.type === "redirect" && input.redirectTarget === input.domain) {
      throw new ORPCError("BAD_REQUEST", {
        message: "A domain cannot redirect to itself",
      });
    }

    return addDomain(input.serviceId, service.environmentId, {
      domain: input.domain,
      type: input.type,
      redirectTarget: input.redirectTarget,
      redirectCode: input.redirectCode,
    });
  }),

  update: os.domains.update.handler(async ({ input }) => {
    assertDemoWriteAllowed("domain changes");

    const domain = await getDomain(input.id);
    if (!domain) {
      throw new ORPCError("NOT_FOUND", { message: "Domain not found" });
    }

    const nextType = input.type ?? domain.type;
    const updates: Parameters<typeof updateDomain>[1] = {};
    if (input.type !== undefined) updates.type = input.type;

    if (nextType === "proxy") {
      updates.redirectTarget = null;
    } else {
      const nextTarget = input.redirectTarget ?? domain.redirectTarget;
      if (!nextTarget) {
        throw new ORPCError("BAD_REQUEST", {
          message: "redirectTarget is required for redirect type",
        });
      }
      if (nextTarget === domain.domain) {
        throw new ORPCError("BAD_REQUEST", {
          message: "A domain cannot redirect to itself",
        });
      }
      updates.redirectTarget = nextTarget;
      updates.redirectCode = input.redirectCode ?? domain.redirectCode ?? 301;
    }

    const updated = await updateDomain(input.id, updates);

    if (domain.dnsVerified) {
      try {
        await syncCaddyConfig();
      } catch (err) {
        console.error("Failed to sync Caddy config after domain update:", err);
      }
    }

    return updated;
  }),

  delete: os.domains.delete.handler(async ({ input }) => {
    assertDemoWriteAllowed("domain changes");

    const domain = await getDomain(input.id);
    if (!domain) {
      throw new ORPCError("NOT_FOUND", { message: "Domain not found" });
    }

    if (domain.isSystem) {
      const otherVerifiedDomains = await db
        .selectFrom("domains")
        .select("id")
        .where("serviceId", "=", domain.serviceId)
        .where("id", "!=", input.id)
        .where("dnsVerified", "=", true)
        .execute();

      if (otherVerifiedDomains.length === 0) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            "Cannot delete system domain when no other verified domain exists",
        });
      }
    }

    await removeDomain(input.id);

    if (domain.dnsVerified) {
      try {
        await syncCaddyConfig();
      } catch (err) {
        console.error("Failed to sync Caddy config after domain delete:", err);
      }
    }

    return { success: true };
  }),

  verifyDns: os.domains.verifyDns.handler(async ({ input }) => {
    const domain = await getDomain(input.id);
    if (!domain) {
      throw new ORPCError("NOT_FOUND", { message: "Domain not found" });
    }

    const dnsStatus = await verifyDomainDns(domain.domain);

    if (dnsStatus.valid) {
      if (!domain.dnsVerified) {
        await updateDomain(input.id, { dnsVerified: true });
      }
      // Always re-sync so a previously failed sync is retried.
      try {
        await syncCaddyConfig();
      } catch (err) {
        console.error("Failed to sync Caddy config:", err);
      }
    }

    return { ...dnsStatus, dnsVerified: dnsStatus.valid };
  }),

  verifySsl: os.domains.verifySsl.handler(async ({ input }) => {
    const domain = await getDomain(input.id);
    if (!domain) {
      throw new ORPCError("NOT_FOUND", { message: "Domain not found" });
    }

    if (!domain.dnsVerified) {
      throw new ORPCError("BAD_REQUEST", { message: "DNS not verified" });
    }

    if (domain.sslStatus === "active") {
      return { working: true, status: "active" as const };
    }

    const staging = (await getSetting("ssl_staging")) === "true";
    const result = await checkHttps(domain.domain, !staging);

    if (result.ok) {
      await updateDomain(input.id, { sslStatus: "active" });
      return { working: true, status: "active" as const };
    }

    return {
      working: false,
      status: "pending" as const,
      error: result.error,
    };
  }),
};
