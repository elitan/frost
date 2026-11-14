import { beforeEach, describe, expect, it } from "bun:test";
import { isRegisteredServiceIcon } from "./service-icons";
import {
  clearTemplateCache,
  generateCredential,
  getDatabaseTemplates,
  getManagedTemplateDatabases,
  getProjectTemplates,
  getServiceTemplates,
  getTemplate,
  getTemplates,
  resolveTemplateServices,
  type Template,
} from "./templates";

beforeEach(() => {
  clearTemplateCache();
});

function requireTemplate(id: string): Template {
  const template = getTemplate(id);
  if (!template) {
    throw new Error(`${id} template not found`);
  }
  return template;
}

describe("getTemplates", () => {
  it("loads all templates from yaml files", () => {
    const templates = getTemplates();
    expect(templates.length).toBeGreaterThan(0);
  });
});

describe("getTemplate", () => {
  it("returns a template by id", () => {
    const template = getTemplate("postgres");
    expect(template).toBeDefined();
    expect(template?.name).toBe("PostgreSQL 17");
  });

  it("returns undefined for unknown template", () => {
    const template = getTemplate("nonexistent");
    expect(template).toBeUndefined();
  });
});

describe("getServiceTemplates", () => {
  it("returns only service templates (not databases)", () => {
    const templates = getServiceTemplates();
    for (const t of templates) {
      expect(t.type).toBe("service");
    }
  });
});

describe("getProjectTemplates", () => {
  it("returns only project templates", () => {
    const templates = getProjectTemplates();
    for (const t of templates) {
      expect(t.type).toBe("project");
    }
  });
});

describe("getDatabaseTemplates", () => {
  it("returns only database templates", () => {
    const templates = getDatabaseTemplates();
    for (const t of templates) {
      expect(t.type).toBe("database");
    }
  });
});

describe("generateCredential", () => {
  it("generates a password of 32 characters", () => {
    const cred = generateCredential("password");
    expect(cred.length).toBe(32);
  });

  it("generates a base64_32 secret", () => {
    const cred = generateCredential("base64_32");
    const decoded = Buffer.from(cred, "base64");
    expect(decoded.length).toBe(32);
  });

  it("generates a base64_64 secret", () => {
    const cred = generateCredential("base64_64");
    const decoded = Buffer.from(cred, "base64");
    expect(decoded.length).toBe(64);
  });
});

describe("getManagedTemplateDatabases", () => {
  it("returns supported managed databases only", () => {
    const template = getTemplate("plausible");
    expect(template).toBeDefined();
    if (!template) return;

    const databases = getManagedTemplateDatabases(template);

    expect(databases).toEqual([
      {
        name: "postgres",
        engine: "postgres",
        image: "postgres:16-alpine",
      },
    ]);
  });

  it("leaves mysql database services unmanaged", () => {
    const template = getTemplate("wordpress");
    expect(template).toBeDefined();
    if (!template) return;

    const databases = getManagedTemplateDatabases(template);

    expect(databases).toEqual([]);
  });
});

describe("resolveTemplateServices", () => {
  it("resolves a single-service template", () => {
    const resolved = resolveTemplateServices(requireTemplate("postgres"));
    expect(resolved.length).toBe(1);

    const svc = resolved[0];
    expect(svc.name).toBe("postgres");
    expect(svc.image).toBe("postgres:17-alpine");
    expect(svc.port).toBe(5432);
    expect(svc.isDatabase).toBe(true);
  });

  it("generates credentials for env vars", () => {
    const resolved = resolveTemplateServices(requireTemplate("postgres"));
    const svc = resolved[0];

    const passwordEnv = svc.envVars.find((e) => e.key === "POSTGRES_PASSWORD");
    expect(passwordEnv).toBeDefined();
    expect(passwordEnv?.value.length).toBe(32);
    expect(passwordEnv?.generated).toBe(true);
  });

  it("resolves cross-service references in project templates", () => {
    const template = getTemplate("plausible");
    expect(template).toBeDefined();
    if (!template) return;

    const resolved = resolveTemplateServices(template);
    expect(resolved.length).toBe(3);

    const plausibleSvc = resolved.find((s) => s.name === "plausible");
    expect(plausibleSvc).toBeDefined();

    const dbUrlEnv = plausibleSvc?.envVars.find(
      (e) => e.key === "DATABASE_URL",
    );
    expect(dbUrlEnv).toBeDefined();
    expect(dbUrlEnv?.value).not.toContain("${");
    expect(dbUrlEnv?.value).toContain("postgres://postgres:");
  });

  it("can swap managed database refs into project templates", () => {
    const template = getTemplate("plausible");
    expect(template).toBeDefined();
    if (!template) return;

    const resolved = resolveTemplateServices(template, {
      excludeServices: ["postgres"],
      referenceValues: {
        postgres: {
          HOST: "postgres--main.frost.internal",
          PORT: "5432",
          USERNAME: "frost",
          PASSWORD: "secret",
          DATABASE: "postgres",
          DATABASE_URL:
            "postgres://frost:secret@postgres--main.frost.internal:5432/postgres?sslmode=require",
          POSTGRES_USER: "frost",
          POSTGRES_PASSWORD: "secret",
          POSTGRES_DB: "postgres",
        },
      },
    });

    expect(resolved.map((service) => service.name)).toEqual([
      "plausible",
      "clickhouse",
    ]);

    const plausibleSvc = resolved.find(
      (service) => service.name === "plausible",
    );
    expect(plausibleSvc).toBeDefined();

    const dbUrlEnv = plausibleSvc?.envVars.find(
      (envVar) => envVar.key === "DATABASE_URL",
    );
    const clickhouseUrlEnv = plausibleSvc?.envVars.find(
      (envVar) => envVar.key === "CLICKHOUSE_DATABASE_URL",
    );

    expect(dbUrlEnv?.value).toBe(
      "postgres://frost:secret@postgres--main.frost.internal:5432/postgres?sslmode=require",
    );
    expect(clickhouseUrlEnv?.value).toBe(
      "http://clickhouse:8123/plausible_events_db",
    );
  });

  it("sets main service correctly in project templates", () => {
    const resolved = resolveTemplateServices(requireTemplate("plausible"));

    const mainServices = resolved.filter((s) => s.isMain);
    expect(mainServices.length).toBe(1);
    expect(mainServices[0].name).toBe("plausible");
  });

  it("parses volumes correctly", () => {
    const resolved = resolveTemplateServices(requireTemplate("postgres"));
    const svc = resolved[0];

    expect(svc.volumes.length).toBe(1);
    expect(svc.volumes[0].name).toBe("data");
    expect(svc.volumes[0].path).toBe("/var/lib/postgresql/data");
  });

  it("uses registered service icons for every template", function testTemplateIcons() {
    const unknownIcons: string[] = [];

    for (const template of getTemplates()) {
      for (const [serviceName, service] of Object.entries(template.services)) {
        if (service.icon && !isRegisteredServiceIcon(service.icon)) {
          unknownIcons.push(`${template.id}/${serviceName}:${service.icon}`);
        }
      }
    }

    expect(unknownIcons).toEqual([]);
  });

  it("starts minio through the minio binary", () => {
    const resolved = resolveTemplateServices(requireTemplate("minio"));
    expect(resolved[0].command).toBe(
      'minio server /data --console-address ":9001"',
    );
  });

  it("exposes the minio console as the public template port", () => {
    const resolved = resolveTemplateServices(requireTemplate("minio"));

    expect(resolved[0].port).toBe(9001);
    expect(resolved[0].healthCheckPath).toBe("/");
    expect(
      resolved[0].envVars.find((envVar) => envVar.key === "S3_ENDPOINT")?.value,
    ).toBe("http://minio:9000");
  });

  it("generates garage admin tokens for companion management tools", () => {
    const resolved = resolveTemplateServices(requireTemplate("garage"));
    const adminToken = resolved[0].envVars.find(
      (envVar) => envVar.key === "GARAGE_ADMIN_TOKEN",
    );
    const metricsToken = resolved[0].envVars.find(
      (envVar) => envVar.key === "GARAGE_METRICS_TOKEN",
    );

    expect(adminToken?.generated).toBe(true);
    expect(adminToken?.value.length).toBe(32);
    expect(metricsToken?.generated).toBe(true);
    expect(metricsToken?.value.length).toBe(32);
  });
});
