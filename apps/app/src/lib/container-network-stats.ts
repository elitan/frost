import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseBytes } from "./monitoring";
import { shellEscape } from "./shell-escape";

const execAsync = promisify(exec);
const DOCKER_API_TIMEOUT_MS = 10_000;

/**
 * Returns the Docker daemon's unix socket, or null when Docker is reached
 * some other way (e.g. a tcp:// DOCKER_HOST).
 */
export function resolveDockerSocketPath(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost) {
    return dockerHost.startsWith("unix://")
      ? dockerHost.slice("unix://".length)
      : null;
  }
  const candidates = [
    "/var/run/docker.sock",
    join(homedir(), ".docker", "run", "docker.sock"),
  ];
  return candidates.find(exists) ?? null;
}

/** Sums rx+tx bytes over all interfaces in a Docker stats API response. */
export function sumNetworkBytes(stats: unknown): number {
  if (!stats || typeof stats !== "object") {
    return 0;
  }
  const networks = (stats as { networks?: unknown }).networks;
  if (!networks || typeof networks !== "object") {
    return 0;
  }
  let total = 0;
  for (const value of Object.values(networks)) {
    if (!value || typeof value !== "object") continue;
    const { rx_bytes, tx_bytes } = value as {
      rx_bytes?: unknown;
      tx_bytes?: unknown;
    };
    if (typeof rx_bytes === "number") total += rx_bytes;
    if (typeof tx_bytes === "number") total += tx_bytes;
  }
  return total;
}

/**
 * Sums TCP segments and UDP datagrams in and out from a `/proc/<pid>/net/snmp`
 * file. Unlike interface byte counters, these ignore ARP, ICMPv6 and stray
 * multicast on the Docker bridge, so an idle container reads as idle.
 */
export function parseSnmpTrafficCount(content: string): number | null {
  const sections = new Map<string, Map<string, number>>();
  const headers = new Map<string, string[]>();
  for (const line of content.split("\n")) {
    const match = line.match(/^(\w+):\s+(.*)$/);
    if (!match) continue;
    const [, section, rest] = match;
    const fields = rest.trim().split(/\s+/);
    const header = headers.get(section);
    if (!header) {
      headers.set(section, fields);
      continue;
    }
    const values = new Map<string, number>();
    header.forEach(function mapField(name, index) {
      values.set(name, Number(fields[index]));
    });
    sections.set(section, values);
  }
  const tcp = sections.get("Tcp");
  const udp = sections.get("Udp");
  if (!tcp) return null;
  const counters = [
    tcp.get("InSegs"),
    tcp.get("OutSegs"),
    udp?.get("InDatagrams") ?? 0,
    udp?.get("OutDatagrams") ?? 0,
  ];
  let total = 0;
  for (const value of counters) {
    if (value === undefined || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

function fetchFromSocket(socketPath: string, path: string): Promise<unknown> {
  return new Promise(function fetchStats(resolve, reject) {
    const req = request(
      {
        socketPath,
        path,
        method: "GET",
        timeout: DOCKER_API_TIMEOUT_MS,
      },
      function onResponse(res) {
        const chunks: Buffer[] = [];
        res.on("data", function onData(chunk: Buffer) {
          chunks.push(chunk);
        });
        res.on("end", function onEnd() {
          if (res.statusCode !== 200) {
            reject(new Error(`Docker API returned ${res.statusCode ?? "?"}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", function onTimeout() {
      req.destroy(new Error("Docker API timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getNetworkBytesFromCli(containerId: string): Promise<number> {
  const { stdout } = await execAsync(
    `docker stats --no-stream --format '{{.NetIO}}' ${shellEscape(containerId)}`,
  );
  const [rx, tx] = stdout.trim().split(" / ");
  return parseBytes(rx ?? "0B") + parseBytes(tx ?? "0B");
}

/**
 * Total bytes a container has sent and received since it started. Reads
 * exact counters from the Docker API when the socket is reachable; falls back
 * to `docker stats`, which only reports 3 significant digits. Returns null
 * when the container cannot be measured.
 */
export async function getContainerNetworkBytes(
  containerId: string,
): Promise<number | null> {
  const socketPath = resolveDockerSocketPath();
  if (socketPath) {
    try {
      return sumNetworkBytes(
        await fetchFromSocket(
          socketPath,
          `/containers/${encodeURIComponent(containerId)}/stats?stream=false&one-shot=true`,
        ),
      );
    } catch {
      // Fall through to the CLI.
    }
  }
  try {
    return await getNetworkBytesFromCli(containerId);
  } catch {
    return null;
  }
}

async function getContainerPid(containerId: string): Promise<number | null> {
  let pid: unknown = null;
  const socketPath = resolveDockerSocketPath();
  if (socketPath) {
    try {
      const info = (await fetchFromSocket(
        socketPath,
        `/containers/${encodeURIComponent(containerId)}/json`,
      )) as { State?: { Pid?: unknown } };
      pid = info.State?.Pid ?? null;
    } catch {
      // Fall through to the CLI.
    }
  }
  if (pid === null) {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format '{{.State.Pid}}' ${shellEscape(containerId)}`,
      );
      pid = Number(stdout.trim());
    } catch {
      return null;
    }
  }
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0
    ? pid
    : null;
}

/**
 * A counter that grows whenever a container sends or receives traffic. On
 * Linux (where Frost runs in production, as root) it reads the container's
 * TCP/UDP counters from /proc, which ignore background bridge noise. Elsewhere
 * (e.g. Docker Desktop, where the container's /proc is inside a VM) it falls
 * back to interface byte counters. Returns null when it can't be measured.
 */
export async function getContainerTrafficCounter(
  containerId: string,
): Promise<number | null> {
  if (process.platform === "linux") {
    const pid = await getContainerPid(containerId);
    if (pid !== null) {
      try {
        const count = parseSnmpTrafficCount(
          await readFile(`/proc/${pid}/net/snmp`, "utf8"),
        );
        if (count !== null) return count;
      } catch {
        // Fall back to byte counters.
      }
    }
  }
  return getContainerNetworkBytes(containerId);
}
