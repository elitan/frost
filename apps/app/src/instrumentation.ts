export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRequiredJwtSecret } = await import("./lib/jwt-secret");
    getRequiredJwtSecret();
    console.log("[startup] jwt secret: ok");

    const { runMigrations } = await import("./lib/migrate");
    runMigrations();
    console.log("[startup] migrations: ok");

    const { ensureDockerNetworkConfig } = await import("./lib/docker-config");
    const dockerRestarted = await ensureDockerNetworkConfig().catch((err) => {
      console.error("[startup] docker: failed to configure network pools", err);
      return false;
    });
    console.log(
      dockerRestarted
        ? "[startup] docker: configured network pools, restarted"
        : "[startup] docker: network pools ok",
    );

    const { persistUpdateResult } = await import("./lib/updater");
    await persistUpdateResult();

    const { reconcileDeploymentStartupState, startDeploymentReconciler } =
      await import("./lib/deployment-runtime");
    const deploymentStartupState = await reconcileDeploymentStartupState();
    if (
      deploymentStartupState.failedDeployments > 0 ||
      deploymentStartupState.stoppedOrphanContainers > 0
    ) {
      console.log(
        `[startup] deployments: failed ${deploymentStartupState.failedDeployments} in-progress deployment(s), stopped ${deploymentStartupState.stoppedOrphanContainers} orphan container(s)`,
      );
    } else {
      console.log("[startup] deployments: no stale deployments or containers");
    }
    startDeploymentReconciler();
    console.log("[startup] deployment reconciler: started");

    const { recoverInterruptedDatabaseImportJobs } = await import(
      "./lib/postgres-import"
    );
    try {
      const interruptedImports = await recoverInterruptedDatabaseImportJobs();
      console.log(
        interruptedImports > 0
          ? `[startup] database imports: marked ${interruptedImports} interrupted job(s) as failed`
          : "[startup] database imports: no interrupted jobs",
      );
    } catch (err) {
      console.error("[startup] database imports: recovery failed", err);
    }

    const { resetInterruptedCleanup } = await import("./lib/cleanup");
    try {
      if (await resetInterruptedCleanup()) {
        console.log(
          "[startup] cleanup: cleared lock left by an interrupted run",
        );
      }
    } catch (err) {
      console.error("[startup] cleanup: failed to reset lock", err);
    }

    const { startMetricsCollector } = await import("./lib/metrics-collector");
    startMetricsCollector();
    console.log("[startup] metrics collector: started");

    const { startUpdateScheduler } = await import("./lib/update-scheduler");
    startUpdateScheduler();
    console.log("[startup] update scheduler: started");

    const { startPostgresBackupScheduler } = await import(
      "./lib/postgres-backup-scheduler"
    );
    startPostgresBackupScheduler();
    console.log("[startup] postgres backup scheduler: started");

    const { startFrostBackupScheduler } = await import("./lib/frost-db-backup");
    startFrostBackupScheduler();
    console.log("[startup] frost database backup scheduler: started");

    const { restoreDatabaseTargetGateways } = await import(
      "./lib/database-runtime"
    );
    await restoreDatabaseTargetGateways();
    console.log("[startup] database target gateways: restored");

    const { startDatabaseTargetPolicyScheduler } = await import(
      "./lib/database-target-policy-scheduler"
    );
    startDatabaseTargetPolicyScheduler();
    console.log("[startup] database target policy scheduler: started");

    const { startCaddyReconcileScheduler } = await import(
      "./lib/caddy-reconcile"
    );
    if (startCaddyReconcileScheduler()) {
      console.log("[startup] caddy reconcile scheduler: started");
    }

    const { syncCaddyConfig } = await import("./lib/domains");
    try {
      const result = await syncCaddyConfig();
      if (!result.synced) {
        console.log("[startup] caddy sync: skipped (no domains)");
        return;
      }
      const parts = [
        result.frostDomain,
        result.serviceDomains > 0 && `${result.serviceDomains} service domains`,
      ].filter(Boolean);
      console.log(`[startup] caddy sync: ok (${parts.join(", ")})`);
      if (result.staging) console.log("[startup] ssl: staging mode");
    } catch (err) {
      console.error("[startup] caddy sync: failed", err);
    }
  }
}
