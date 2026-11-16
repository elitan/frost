import { exec, execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { promisify } from "node:util";
import pkg from "../../package.json";
import { db } from "./db";
import { createNetwork } from "./docker";
import { getRequiredJwtSecret } from "./jwt-secret";
import { shellEscape } from "./shell-escape";
import { slugify } from "./slugify";

/**
 * Internal wake for scale-to-zero.
 *
 * Containers reach each other by `<hostname>.frost.internal` on their Docker
 * network, which never passes through Caddy. While a service sleeps, Frost
 * runs a tiny stand-in (apps/activator, ~2 MB idle) under that name and port.
 * The first connection makes it call POST /activate/<serviceId> here; Frost
 * wakes the service and answers with the containers' IPs; the stand-in
 * forwards held connections, then exits on its own.
 */

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const PROBE_NETWORK = "frost-activator-probe";

const globalForActivator = globalThis as typeof globalThis & {
  frostActivatorControlServer?: Server;
  /** Set once the wake endpoint listens; proxies are only started then. */
  frostActivatorEndpoint?: ActivatorEndpoint;
};

const ACTIVATOR_LABEL = "frost.activator";
const DEFAULT_CONTROL_PORT = 3091;

/**
 * The wake proxy image, built locally by install.sh/update.sh: from the
 * release tarball's binaries as frost-activator:<version>, or from source
 * (which sets FROST_ACTIVATOR_IMAGE).
 */
export function getActivatorImage(): string {
  return process.env.FROST_ACTIVATOR_IMAGE || `frost-activator:${pkg.version}`;
}

function getConfiguredControlPort(): number {
  const port = Number.parseInt(process.env.FROST_ACTIVATOR_PORT ?? "", 10);
  return Number.isInteger(port) && port >= 0 && port < 65536
    ? port
    : DEFAULT_CONTROL_PORT;
}

/** The port the wake endpoint listens on (the bound one once started). */
export function getActivatorControlPort(): number {
  return (
    globalForActivator.frostActivatorEndpoint?.port ??
    getConfiguredControlPort()
  );
}

export interface ActivatorEndpoint {
  /** Address the wake endpoint listens on. */
  bindHost: string;
  /** What containers map host.docker.internal to (an IP or host-gateway). */
  hostGateway: string;
  port: number;
}

/**
 * Where containers can reach the wake endpoint without exposing it outside
 * the host. On Linux both sides use the default Docker bridge's gateway IP:
 * every container network reaches it through the host, the internet doesn't.
 * Docker Desktop forwards host-gateway to the host's loopback.
 * FROST_ACTIVATOR_HOST overrides the bind address.
 */
export async function resolveActivatorEndpoint(
  port: number,
): Promise<ActivatorEndpoint> {
  const override = process.env.FROST_ACTIVATOR_HOST;
  if (override) {
    const specific =
      isIP(override) !== 0 &&
      !["0.0.0.0", "::", "127.0.0.1", "::1"].includes(override);
    return {
      bindHost: override,
      hostGateway: specific ? override : "host-gateway",
      port,
    };
  }
  if (process.platform !== "linux") {
    return { bindHost: "127.0.0.1", hostGateway: "host-gateway", port };
  }
  const { stdout } = await execAsync(
    `docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}'`,
  );
  const gateway = stdout
    .trim()
    .split(/\s+/)
    .find((ip) => isIP(ip) === 4);
  if (!gateway) {
    throw new Error("The default Docker bridge has no IPv4 gateway");
  }
  return { bindHost: gateway, hostGateway: gateway, port };
}

/**
 * The --add-host value for wake proxies, or null while the wake endpoint
 * isn't listening (proxies then aren't started: nothing could wake them).
 */
export function getActivatorHostGateway(): string | null {
  const endpoint = globalForActivator.frostActivatorEndpoint;
  return endpoint ? `host.docker.internal:${endpoint.hostGateway}` : null;
}

export function activatorContainerName(serviceId: string): string {
  return `frost-activator-${serviceId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/** Per-service token, so a stand-in can only wake its own service. */
export function activatorToken(serviceId: string): string {
  return createHmac("sha256", getRequiredJwtSecret())
    .update(`activator:${serviceId}`)
    .digest("hex");
}

export function isValidActivatorToken(
  serviceId: string,
  token: string,
): boolean {
  const expected = Buffer.from(activatorToken(serviceId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Loopback, RFC 1918 and unique-local addresses: where containers come from. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return ip === "::1" || /^f[cd]/i.test(ip);
}

interface ActivatorTarget {
  serviceId: string;
  hostname: string;
  containerPort: number;
  containerIds: string[];
}

async function getActivatorTarget(
  serviceId: string,
): Promise<ActivatorTarget | null> {
  const row = await db
    .selectFrom("services")
    .innerJoin("deployments", "deployments.id", "services.currentDeploymentId")
    .select([
      "services.id",
      "services.name",
      "services.hostname",
      "deployments.id as deploymentId",
      "deployments.containerId",
      "deployments.containerPort",
    ])
    .where("services.id", "=", serviceId)
    .executeTakeFirst();
  if (!row) return null;
  const replicas = await db
    .selectFrom("replicas")
    .select("containerId")
    .where("deploymentId", "=", row.deploymentId)
    .where("status", "=", "running")
    .execute();
  const containerIds = replicas.flatMap((r) =>
    r.containerId ? [r.containerId] : [],
  );
  if (containerIds.length === 0 && row.containerId) {
    containerIds.push(row.containerId);
  }
  return {
    serviceId: row.id,
    hostname: row.hostname ?? slugify(row.name),
    containerPort: row.containerPort ?? 8080,
    containerIds,
  };
}

/** The Frost network a (possibly stopped) container is attached to. */
async function getContainerNetwork(containerId: string): Promise<string> {
  const { stdout } = await execAsync(
    `docker inspect --format '{{json .NetworkSettings.Networks}}' ${shellEscape(containerId)}`,
  );
  const networks = Object.keys(JSON.parse(stdout.trim()) as object);
  const network = networks.find((n) => n.startsWith("frost-net-"));
  if (!network) {
    throw new Error(`Container ${containerId} is not on a Frost network`);
  }
  return network;
}

async function getContainerIp(
  containerId: string,
  network: string,
): Promise<string> {
  const { stdout } = await execAsync(
    `docker inspect --format ${shellEscape(`{{(index .NetworkSettings.Networks "${network}").IPAddress}}`)} ${shellEscape(containerId)}`,
  );
  const ip = stdout.trim();
  if (!isIP(ip)) {
    throw new Error(`Container ${containerId} has no IP on ${network}`);
  }
  return ip;
}

export async function stopServiceActivator(serviceId: string): Promise<void> {
  await execAsync(
    `docker rm -f ${shellEscape(activatorContainerName(serviceId))}`,
  ).catch(() => {});
}

/**
 * Starts the stand-in for a sleeping service. Best effort: if it fails, the
 * service still sleeps and still wakes through its domains.
 */
export async function startServiceActivator(serviceId: string): Promise<void> {
  const target = await getActivatorTarget(serviceId);
  const firstContainer = target?.containerIds[0];
  const hostGateway = getActivatorHostGateway();
  if (!target || !firstContainer || !hostGateway) return;
  const network = await getContainerNetwork(firstContainer);
  await stopServiceActivator(serviceId);
  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    activatorContainerName(serviceId),
    "--network",
    network,
    "--network-alias",
    `${target.hostname}.frost.internal`,
    "--add-host",
    hostGateway,
    "--label",
    `${ACTIVATOR_LABEL}=true`,
    // Removed with the service by cleanupService (stopContainersByLabel).
    "--label",
    `frost.service.id=${serviceId}`,
    "--memory",
    "64m",
    "--pids-limit",
    "2100",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    `ACTIVATOR_PORTS=${target.containerPort}`,
    "-e",
    `ACTIVATOR_WAKE_URL=http://host.docker.internal:${getActivatorControlPort()}/activate/${serviceId}`,
    // Value from our environment, so it never appears in a command line or
    // an error message.
    "-e",
    "ACTIVATOR_TOKEN",
    getActivatorImage(),
  ];
  await execAsync(`docker ${args.map(shellEscape).join(" ")}`, {
    env: { ...process.env, ACTIVATOR_TOKEN: activatorToken(serviceId) },
  });
}

async function getActivatorState(serviceId: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format '{{.State.Status}}' ${shellEscape(activatorContainerName(serviceId))}`,
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

const PRESENT_STATES = new Set(["created", "running", "restarting"]);

async function isServiceSleeping(serviceId: string): Promise<boolean> {
  const row = await db
    .selectFrom("services")
    .select("sleepingSince")
    .where("id", "=", serviceId)
    .executeTakeFirst();
  return row !== undefined && row.sleepingSince !== null;
}

/**
 * Makes the stand-ins match the sleeping services: starts missing ones (e.g.
 * after a host reboot; they run with --rm) and removes exited leftovers.
 * Each service is handled under `withServiceLock`, the lock sleep and wake
 * use, so this never replaces a stand-in that is being started or used.
 */
export async function reconcileServiceActivators(
  withServiceLock: <T>(serviceId: string, task: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const sleeping = await db
    .selectFrom("services")
    .select("id")
    .where("sleepingSince", "is not", null)
    .where("serviceType", "=", "app")
    .execute();
  const { stdout } = await execAsync(
    `docker ps -a --filter label=${ACTIVATOR_LABEL}=true --format ${shellEscape('{{.Label "frost.service.id"}}')}`,
  );
  const candidates = new Set(sleeping.map((s) => s.id));
  for (const line of stdout.trim().split("\n")) {
    if (line) candidates.add(line);
  }

  for (const serviceId of candidates) {
    await withServiceLock(serviceId, async () => {
      const state = await getActivatorState(serviceId);
      const present = state !== null && PRESENT_STATES.has(state);
      if (await isServiceSleeping(serviceId)) {
        if (!present) await startServiceActivator(serviceId);
      } else if (state !== null && !present) {
        // An awake service's running stand-in exits on its own; only
        // exited leftovers are removed.
        await stopServiceActivator(serviceId);
      }
    }).catch((error) => {
      console.error("[activator] Reconcile failed", { serviceId, error });
    });
  }
}

export interface ActivatorControlOptions {
  ensureServiceAwake: (serviceId: string) => Promise<number[]>;
  /** Database proxies: wakes the target, returns hosts to forward to. */
  wakeDatabaseTarget?: (targetId: string) => Promise<string[]>;
}

/** Wakes the service, then returns its container IPs, one per line. */
async function activate(
  serviceId: string,
  options: ActivatorControlOptions,
): Promise<string[]> {
  await options.ensureServiceAwake(serviceId);
  const target = await getActivatorTarget(serviceId);
  const firstContainer = target?.containerIds[0];
  if (!target || !firstContainer) {
    throw new Error("Service has no running deployment");
  }
  const network = await getContainerNetwork(firstContainer);
  return Promise.all(
    target.containerIds.map((id) => getContainerIp(id, network)),
  );
}

export function createActivatorControlServer(
  options: ActivatorControlOptions,
): Server {
  const server = createServer(async function onRequest(req, res) {
    const remote = req.socket.remoteAddress ?? "";
    if (req.method === "GET" && req.url === "/healthz") {
      // The startup probe: answered for container sources only.
      res.writeHead(isPrivateAddress(remote) ? 200 : 403).end();
      return;
    }
    const match = req.url?.match(/^\/activate\/(target\/)?([A-Za-z0-9_-]+)$/);
    if (req.method !== "POST" || !match) {
      res.writeHead(404).end();
      return;
    }
    const isTarget = match[1] !== undefined;
    const id = match[2];
    const tokenSubject = isTarget ? `target:${id}` : id;
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (
      !isPrivateAddress(remote) ||
      !isValidActivatorToken(tokenSubject, token)
    ) {
      res.writeHead(403).end();
      return;
    }
    const serviceId = id;
    try {
      let hosts: string[];
      if (isTarget) {
        if (!options.wakeDatabaseTarget) {
          throw new Error("Database proxies are not supported");
        }
        hosts = await options.wakeDatabaseTarget(id);
      } else {
        hosts = await activate(serviceId, options);
      }
      const body = `${hosts.join("\n")}\n`;
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    } catch (error) {
      console.error("[activator] Activation failed", { serviceId, error });
      res.writeHead(503).end();
    }
  });
  server.requestTimeout = 0;
  return server;
}

export async function startActivatorControlServer(
  options: ActivatorControlOptions,
): Promise<ActivatorEndpoint> {
  const running = globalForActivator.frostActivatorEndpoint;
  if (globalForActivator.frostActivatorControlServer && running) {
    return running;
  }
  const endpoint = await resolveActivatorEndpoint(getConfiguredControlPort());
  const server = createActivatorControlServer(options);
  globalForActivator.frostActivatorControlServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      globalForActivator.frostActivatorControlServer = undefined;
      reject(error);
    });
    // Requests also need a per-service token and a private source address.
    server.listen(endpoint.port, endpoint.bindHost, () => resolve());
  });
  const address = server.address();
  const bound: ActivatorEndpoint = {
    ...endpoint,
    port: typeof address === "object" && address ? address.port : endpoint.port,
  };
  try {
    await probeActivatorEndpoint(bound);
  } catch (error) {
    globalForActivator.frostActivatorControlServer = undefined;
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  // Only now do wake proxies start (see getActivatorHostGateway).
  globalForActivator.frostActivatorEndpoint = bound;
  return bound;
}

/**
 * Checks, from a container on a Docker network like the ones services use,
 * that the wake endpoint answers. Fails when the proxy image is missing or a
 * host firewall drops container-to-host traffic; Frost then runs without
 * wake proxies (services wake through their domains, databases sleep without
 * a proxy) instead of starting proxies nothing could wake.
 */
async function probeActivatorEndpoint(
  endpoint: ActivatorEndpoint,
): Promise<void> {
  await createNetwork(PROBE_NETWORK, { "frost.managed": "true" });
  try {
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        PROBE_NETWORK,
        "--add-host",
        `host.docker.internal:${endpoint.hostGateway}`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        getActivatorImage(),
        "probe",
        `http://host.docker.internal:${endpoint.port}/healthz`,
      ],
      { timeout: 60_000 },
    );
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
    throw new Error(
      `Containers can't reach the wake endpoint on ${endpoint.bindHost}:${endpoint.port} ` +
        `(image ${getActivatorImage()}): ${detail}. ` +
        `If a host firewall blocks traffic from Docker networks to the host, allow TCP port ${endpoint.port} from them.`,
    );
  }
}

export async function stopActivatorControlServer(): Promise<void> {
  const server = globalForActivator.frostActivatorControlServer;
  globalForActivator.frostActivatorControlServer = undefined;
  globalForActivator.frostActivatorEndpoint = undefined;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}
