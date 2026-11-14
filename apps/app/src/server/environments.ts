import { ORPCError } from "@orpc/server";
import { ensureEnvironmentPostgresNetworkAccess } from "@/lib/database-runtime";
import { db } from "@/lib/db";
import { deployEnvironment } from "@/lib/deployer";
import { addLatestDeploymentsWithRuntimeStatus } from "@/lib/deployment-runtime";
import { newEnvironmentId } from "@/lib/id";
import { cleanupEnvironment } from "@/lib/lifecycle";
import {
  USER_FACING_SERVICE_TYPES,
  type UserFacingServiceType,
} from "@/lib/service-visibility";
import { createService } from "@/lib/services";
import { slugifyWithFallback } from "@/lib/slugify";
import {
  assertDemoDeployRateLimit,
  assertDemoEnvironmentCreateAllowed,
  assertDemoServiceCreateAllowed,
} from "./demo-guards";
import { os } from "./orpc";

function loadEnvironment(id: string) {
  return db
    .selectFrom("environments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

export const environments = {
  list: os.environments.list.handler(async ({ input }) => {
    return db
      .selectFrom("environments")
      .selectAll()
      .where("projectId", "=", input.projectId)
      .orderBy("createdAt", "asc")
      .execute();
  }),

  get: os.environments.get.handler(async ({ input }) => {
    const environment = await db
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", input.envId)
      .executeTakeFirst();

    if (!environment) {
      throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    }

    const services = await db
      .selectFrom("services")
      .selectAll()
      .where("environmentId", "=", input.envId)
      .where("serviceType", "in", USER_FACING_SERVICE_TYPES)
      .execute();

    const servicesWithDeployments =
      await addLatestDeploymentsWithRuntimeStatus(services);

    return { ...environment, services: servicesWithDeployments };
  }),

  create: os.environments.create.handler(async ({ input }) => {
    await assertDemoEnvironmentCreateAllowed(input.projectId);

    const project = await db
      .selectFrom("projects")
      .select(["id", "hostname", "name"])
      .where("id", "=", input.projectId)
      .executeTakeFirst();

    if (!project) {
      throw new ORPCError("NOT_FOUND", { message: "Project not found" });
    }

    const existing = await db
      .selectFrom("environments")
      .select("id")
      .where("projectId", "=", input.projectId)
      .where("name", "=", input.name)
      .executeTakeFirst();

    if (existing) {
      throw new ORPCError("CONFLICT", {
        message: "Environment with this name already exists",
      });
    }

    const id = newEnvironmentId();
    const now = Date.now();

    await db
      .insertInto("environments")
      .values({
        id,
        projectId: input.projectId,
        name: input.name,
        type: input.type,
        isEphemeral: false,
        createdAt: now,
      })
      .execute();

    let shouldDeploy = false;
    let environment: NonNullable<Awaited<ReturnType<typeof loadEnvironment>>>;

    try {
      if (input.cloneFromEnvironmentId) {
        const sourceEnv = await db
          .selectFrom("environments")
          .select("id")
          .where("id", "=", input.cloneFromEnvironmentId)
          .where("projectId", "=", input.projectId)
          .executeTakeFirst();

        if (sourceEnv) {
          const sourceServices = await db
            .selectFrom("services")
            .selectAll()
            .where("environmentId", "=", sourceEnv.id)
            .where("serviceType", "in", USER_FACING_SERVICE_TYPES)
            .execute();

          await assertDemoServiceCreateAllowed(id, sourceServices.length);

          const projectHostname =
            project.hostname ?? slugifyWithFallback(project.name, "project");
          const envName = slugifyWithFallback(input.name, "env");

          for (const service of sourceServices) {
            const hostname =
              service.hostname ?? slugifyWithFallback(service.name, "service");
            const envVars = service.envVars
              ? (JSON.parse(service.envVars) as {
                  key: string;
                  value: string;
                  buildTime?: boolean;
                }[])
              : [];
            const volumes = service.volumes
              ? (JSON.parse(service.volumes) as {
                  name: string;
                  path: string;
                }[])
              : [];

            await createService({
              environmentId: id,
              name: service.name,
              hostname,
              deployType: service.deployType as "repo" | "image",
              serviceType: service.serviceType as UserFacingServiceType,
              repoUrl: service.repoUrl,
              branch: service.branch,
              dockerfilePath: service.dockerfilePath,
              buildContext: service.buildContext,
              imageUrl: service.imageUrl,
              envVars,
              containerPort: service.containerPort,
              healthCheckPath: service.healthCheckPath,
              healthCheckTimeout: service.healthCheckTimeout,
              memoryLimit: service.memoryLimit,
              cpuLimit: service.cpuLimit,
              shutdownTimeout: service.shutdownTimeout,
              registryId: service.registryId,
              command: service.command,
              volumes,
              drainTimeout: service.drainTimeout,
              requestTimeout: service.requestTimeout,
              replicaCount: service.replicaCount,
              autoDeploy: Boolean(service.autoDeploy),
              frostFilePath: service.frostFilePath,
              icon: service.icon,
              wildcardDomain: { projectHostname, environmentName: envName },
            });
          }

          if (sourceServices.length > 0) {
            shouldDeploy = true;
          }
        }
      }

      const created = await loadEnvironment(id);

      if (!created) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create environment",
        });
      }

      environment = created;

      await ensureEnvironmentPostgresNetworkAccess(id);
    } catch (error) {
      try {
        await cleanupEnvironment({ id, projectId: input.projectId });
      } catch (cleanupError) {
        console.error(
          `Failed to clean up environment ${id} after create error:`,
          cleanupError,
        );
      }
      throw error;
    }

    if (shouldDeploy) {
      deployEnvironment(id).catch(console.error);
    }

    return environment;
  }),

  update: os.environments.update.handler(async ({ input }) => {
    const environment = await db
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", input.envId)
      .executeTakeFirst();

    if (!environment) {
      throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    }

    if (input.name && input.name !== environment.name) {
      const existing = await db
        .selectFrom("environments")
        .select("id")
        .where("projectId", "=", environment.projectId)
        .where("name", "=", input.name)
        .where("id", "!=", input.envId)
        .executeTakeFirst();

      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: "Environment with this name already exists",
        });
      }
    }

    await db
      .updateTable("environments")
      .set({
        name: input.name ?? environment.name,
      })
      .where("id", "=", input.envId)
      .execute();

    const updated = await db
      .selectFrom("environments")
      .selectAll()
      .where("id", "=", input.envId)
      .executeTakeFirst();

    if (!updated) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to update environment",
      });
    }

    return updated;
  }),

  delete: os.environments.delete.handler(async ({ input }) => {
    const environment = await db
      .selectFrom("environments")
      .select(["id", "projectId", "type"])
      .where("id", "=", input.envId)
      .executeTakeFirst();

    if (!environment) {
      throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    }

    if (environment.type === "production") {
      throw new ORPCError("BAD_REQUEST", {
        message: "Cannot delete production environment",
      });
    }

    await cleanupEnvironment(environment);
    return { success: true };
  }),

  deploy: os.environments.deploy.handler(async ({ input }) => {
    const environment = await db
      .selectFrom("environments")
      .select("id")
      .where("id", "=", input.envId)
      .executeTakeFirst();

    if (!environment) {
      throw new ORPCError("NOT_FOUND", { message: "Environment not found" });
    }

    const services = await db
      .selectFrom("services")
      .select("id")
      .where("environmentId", "=", input.envId)
      .where("serviceType", "in", USER_FACING_SERVICE_TYPES)
      .execute();
    for (const service of services) {
      await assertDemoDeployRateLimit(service.id);
    }

    const deploymentIds = await deployEnvironment(input.envId);
    return { deploymentIds };
  }),
};
