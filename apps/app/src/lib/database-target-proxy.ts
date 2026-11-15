import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  activatorToken,
  getActivatorControlPort,
  getActivatorImage,
} from "./service-activator";
import { shellEscape } from "./shell-escape";

/**
 * EXPERIMENT: a resident proxy (apps/activator in resident mode) in front of
 * each scale-to-zero Postgres target.
 *
 * The proxy owns the target's internal hostnames on every environment network
 * for good; the database container itself carries no aliases and is reached
 * by its container name. When the database is asleep, the proxy holds
 * connections and asks Frost (POST /activate/target/<id>) to wake it. Frost
 * sleeps the database through the proxy's control commands (pause, commit,
 * sleep, resume) so no query can reach a database that is stopping. TLS
 * passes through untouched.
 */

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const PROXY_LABEL = "frost.database.proxy";
const PROXY_CONFIG_LABEL = "frost.database.proxy.config";

export interface DatabaseProxyNetwork {
  network: string;
  aliases: string[];
}

export function getDatabaseProxyContainerName(targetId: string): string {
  return `frost-dbproxy-${targetId}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function getDatabaseProxyToken(targetId: string): string {
  return activatorToken(`target:${targetId}`);
}

export interface ContainerNetworkAliases {
  running: boolean;
  labels: Record<string, string>;
  /** Network name to user-set aliases. */
  aliases: Map<string, string[]>;
}

/**
 * A container's networks and the aliases set on each, or null if it doesn't
 * exist. Older Docker versions list the container's short id (and sometimes
 * its name) as aliases; those are dropped so comparisons stay stable.
 */
export async function readContainerNetworkAliases(
  containerName: string,
): Promise<ContainerNetworkAliases | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}}}',
      containerName,
    ]));
  } catch {
    return null;
  }
  const info = JSON.parse(stdout) as {
    id: string;
    name: string;
    running: boolean;
    labels: Record<string, string> | null;
    networks: Record<string, { Aliases?: string[] | null }> | null;
  };
  const name = info.name.replace(/^\//, "");
  return {
    running: info.running,
    labels: info.labels ?? {},
    aliases: new Map(
      Object.entries(info.networks ?? {}).map(([network, value]) => [
        network,
        (value.Aliases ?? []).filter(
          (alias) =>
            alias !== name &&
            !(alias.length >= 12 && info.id.startsWith(alias)),
        ),
      ]),
    ),
  };
}

export function sameAliases(current: string[], desired: string[]): boolean {
  const have = new Set(current);
  return (
    have.size === new Set(desired).size &&
    desired.every((alias) => have.has(alias))
  );
}

async function connect(
  containerName: string,
  { network, aliases }: DatabaseProxyNetwork,
): Promise<void> {
  const args = ["network", "connect"];
  for (const alias of aliases) {
    args.push("--alias", alias);
  }
  args.push(network, containerName);
  await execFileAsync("docker", args);
}

/**
 * Starts the proxy if it isn't running and makes its network attachments and
 * aliases match `networks`. Attachments that already match are left alone, so
 * connections through them survive.
 */
export async function ensureDatabaseProxy(input: {
  targetId: string;
  databaseId: string;
  port: number;
  networks: DatabaseProxyNetwork[];
}): Promise<void> {
  const [first, ...rest] = input.networks;
  if (!first) {
    return;
  }
  const containerName = getDatabaseProxyContainerName(input.targetId);
  const wakeUrl = `http://host.docker.internal:${getActivatorControlPort()}/activate/target/${input.targetId}`;
  const token = getDatabaseProxyToken(input.targetId);
  // Changes to any of these (e.g. a new activator image after an upgrade)
  // recreate the proxy; otherwise a running proxy is left alone.
  const image = getActivatorImage();
  const imageId = await execFileAsync("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]).then(
    (result) => result.stdout.trim(),
    () => image,
  );
  const config = createHash("sha256")
    .update(JSON.stringify([imageId, input.port, wakeUrl, token]))
    .digest("hex")
    .slice(0, 16);
  const existing = await readContainerNetworkAliases(containerName);
  let current =
    existing?.running && existing.labels[PROXY_CONFIG_LABEL] === config
      ? existing.aliases
      : null;

  if (!current) {
    await execAsync(`docker rm -f ${shellEscape(containerName)}`).catch(
      () => {},
    );
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      first.network,
      ...first.aliases.flatMap((alias) => ["--network-alias", alias]),
      "--add-host",
      "host.docker.internal:host-gateway",
      "--restart",
      "unless-stopped",
      "--label",
      "frost.managed=true",
      "--label",
      `${PROXY_LABEL}=true`,
      "--label",
      `frost.database.id=${input.databaseId}`,
      "--label",
      `frost.database.target.id=${input.targetId}`,
      "--label",
      `${PROXY_CONFIG_LABEL}=${config}`,
      "--memory",
      "128m",
      "--pids-limit",
      "2100",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-e",
      "ACTIVATOR_MODE=resident",
      "-e",
      `ACTIVATOR_PORTS=${input.port}`,
      "-e",
      `ACTIVATOR_WAKE_URL=${wakeUrl}`,
      "-e",
      `ACTIVATOR_TOKEN=${token}`,
      image,
    ];
    await execFileAsync("docker", args);
    current = new Map([[first.network, first.aliases]]);
  }

  const desired = new Map(
    [first, ...rest].map((entry) => [entry.network, entry]),
  );
  for (const [network, aliases] of current) {
    const want = desired.get(network);
    if (!want) {
      await execFileAsync("docker", [
        "network",
        "disconnect",
        network,
        containerName,
      ]).catch(() => {});
    } else if (!sameAliases(aliases, want.aliases)) {
      await execFileAsync("docker", [
        "network",
        "disconnect",
        network,
        containerName,
      ]).catch(() => {});
      await connect(containerName, want);
    }
  }
  for (const [network, entry] of desired) {
    if (!current.has(network)) {
      await connect(containerName, entry);
    }
  }
}

export async function removeDatabaseProxy(targetId: string): Promise<void> {
  await execAsync(
    `docker rm -f ${shellEscape(getDatabaseProxyContainerName(targetId))}`,
  ).catch(() => {});
}

/** Target ids of proxy containers (of one database, or all), running or not. */
export async function listDatabaseProxyTargetIds(
  databaseId?: string,
): Promise<string[]> {
  const filters = [`label=${PROXY_LABEL}=true`];
  if (databaseId) {
    filters.push(`label=frost.database.id=${databaseId}`);
  }
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    ...filters.flatMap((filter) => ["--filter", filter]),
    "--format",
    '{{.Label "frost.database.target.id"}}',
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export type DatabaseProxyCommand =
  | "pause"
  | "commit"
  | "sleep"
  | "resume"
  | "status";

export interface DatabaseProxyReply {
  ok: boolean;
  reply: string;
}

/**
 * Sends a control command to the proxy (via docker exec; its control port is
 * bound to the container's loopback). ok is false when the proxy answered
 * anything but "ok", e.g. "busy" for a commit.
 */
export async function controlDatabaseProxy(
  targetId: string,
  command: DatabaseProxyCommand,
): Promise<DatabaseProxyReply> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "exec",
        getDatabaseProxyContainerName(targetId),
        "/frost-activator",
        "ctl",
        command,
      ],
      { timeout: 15_000 },
    );
    return { ok: stdout.startsWith("ok"), reply: stdout.trim() };
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String(error.stdout).trim()
        : "";
    return {
      ok: false,
      reply: stdout || (error instanceof Error ? error.message : "failed"),
    };
  }
}
