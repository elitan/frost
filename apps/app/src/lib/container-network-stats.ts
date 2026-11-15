import { exec } from "node:child_process";
import { existsSync } from "node:fs";
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

function fetchStatsFromSocket(
  socketPath: string,
  containerId: string,
): Promise<unknown> {
  return new Promise(function fetchStats(resolve, reject) {
    const req = request(
      {
        socketPath,
        path: `/containers/${encodeURIComponent(containerId)}/stats?stream=false&one-shot=true`,
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
            reject(
              new Error(`Docker stats API returned ${res.statusCode ?? "?"}`),
            );
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
      req.destroy(new Error("Docker stats API timed out"));
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
        await fetchStatsFromSocket(socketPath, containerId),
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
