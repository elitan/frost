import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import type {
  AssertStorageRemovableOptions,
  BranchStorageBackend,
  BranchStorageHandle,
} from "./branch-storage-backend";

const execFileAsync = promisify(execFile);
const extraCommandDirs = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

export interface ZfsBranchStorageOptions {
  pool: string;
  datasetBase: string;
  mountBase: string;
}

export interface ZfsHostState {
  pools: string[];
  datasets: string[];
}

export function normalizeDatasetBase(datasetBase: string): string {
  return datasetBase.replace(/^\/+|\/+$/g, "");
}

export function normalizeStorageRef(storageRef: string): string {
  return storageRef.replace(/^\/+|\/+$/g, "");
}

export function buildZfsDatasetPath(
  pool: string,
  datasetBase: string,
  storageRef: string,
): string {
  const normalizedBase = normalizeDatasetBase(datasetBase);
  const normalizedStorageRef = normalizeStorageRef(storageRef);
  if (normalizedBase.length === 0) {
    return `${pool}/${normalizedStorageRef}`;
  }
  return `${pool}/${normalizedBase}/${normalizedStorageRef}`;
}

export function buildZfsMountPath(
  mountBase: string,
  storageRef: string,
): string {
  return join(mountBase, normalizeStorageRef(storageRef));
}

export function buildZfsCreateArgs(
  datasetPath: string,
  mountPath: string,
): string[] {
  return [
    "create",
    "-p",
    "-o",
    "compression=lz4",
    "-o",
    "recordsize=8k",
    "-o",
    "atime=off",
    "-o",
    `mountpoint=${mountPath}`,
    datasetPath,
  ];
}

export function buildZfsCloneArgs(
  snapshotName: string,
  targetDatasetPath: string,
  mountPath: string,
): string[] {
  return [
    "clone",
    "-p",
    "-o",
    "compression=lz4",
    "-o",
    "recordsize=8k",
    "-o",
    "atime=off",
    "-o",
    `mountpoint=${mountPath}`,
    snapshotName,
    targetDatasetPath,
  ];
}

function parseZfsNameList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveSystemCommand(
  command: string,
  envPath = process.env.PATH ?? "",
  dirs = extraCommandDirs,
): string {
  const searchDirs = [...envPath.split(":").filter(Boolean), ...dirs];
  const seen = new Set<string>();

  for (const dir of searchDirs) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return command;
}

export function detectZfsHostState(): ZfsHostState | undefined {
  const zpoolCommand = resolveSystemCommand("zpool");
  const zfsCommand = resolveSystemCommand("zfs");
  try {
    return {
      pools: parseZfsNameList(
        execFileSync(zpoolCommand, ["list", "-H", "-o", "name"], {
          encoding: "utf8",
        }),
      ),
      datasets: parseZfsNameList(
        execFileSync(zfsCommand, ["list", "-H", "-o", "name"], {
          encoding: "utf8",
        }),
      ),
    };
  } catch {
    return undefined;
  }
}

export function resolveZfsPool(input: {
  configuredPool?: string;
  datasetBase: string;
  hostState?: ZfsHostState;
}): string {
  const configuredPool = input.configuredPool?.trim() ?? "";
  if (configuredPool.length > 0) {
    return configuredPool;
  }

  const hostState = input.hostState;
  if (!hostState) {
    return "";
  }

  const pools = Array.from(
    new Set(hostState.pools.map((item) => item.trim()).filter(Boolean)),
  );
  if (pools.length === 1) {
    return pools[0];
  }

  const datasetBase = normalizeDatasetBase(input.datasetBase);
  if (datasetBase.length === 0) {
    return "";
  }

  const suffix = `/${datasetBase}`;
  const matchingPools = Array.from(
    new Set(
      hostState.datasets
        .map((item) => item.trim())
        .filter((item) => item.endsWith(suffix))
        .map((item) => item.slice(0, -suffix.length))
        .filter((item) => item.length > 0),
    ),
  );

  if (matchingPools.length === 1) {
    return matchingPools[0];
  }

  return "";
}

function formatExecError(command: string, error: unknown): string {
  if (!error || typeof error !== "object") {
    return `${command} failed`;
  }

  const maybeError = error as {
    message?: string;
    stderr?: string;
    stdout?: string;
  };

  const detail = [maybeError.stderr, maybeError.stdout, maybeError.message]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();

  if (detail.length === 0) {
    return `${command} failed`;
  }

  return `${command} failed: ${detail}`;
}

function isDatasetNotFound(error: unknown): boolean {
  const message = formatExecError("zfs", error).toLowerCase();
  return (
    message.includes("dataset does not exist") ||
    message.includes("no such pool")
  );
}

function isDependentClonesError(error: unknown): boolean {
  const message = formatExecError("zfs", error).toLowerCase();
  return message.includes("dependent clones");
}

/**
 * Parses `zfs list -H -t snapshot -o name,clones` output into the clone
 * datasets that depend on each snapshot.
 */
export function parseZfsSnapshotClones(
  output: string,
): Array<{ snapshot: string; clones: string[] }> {
  return parseZfsNameList(output).map(function parseLine(line) {
    const [snapshot = "", clonesValue = ""] = line.split("\t");
    const clones =
      clonesValue.trim() === "-" || clonesValue.trim() === ""
        ? []
        : clonesValue
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    return { snapshot: snapshot.trim(), clones };
  });
}

export function findBlockingZfsClones(input: {
  snapshots: Array<{ snapshot: string; clones: string[] }>;
  allowedDatasetPrefixes: string[];
}): string[] {
  const blocking: string[] = [];
  for (const entry of input.snapshots) {
    for (const clone of entry.clones) {
      const allowed = input.allowedDatasetPrefixes.some(
        (prefix) => clone === prefix || clone.startsWith(`${prefix}/`),
      );
      if (!allowed) {
        blocking.push(clone);
      }
    }
  }
  return blocking;
}

function isAlreadyMountedError(error: unknown): boolean {
  const message = formatExecError("zfs", error).toLowerCase();
  return message.includes("already mounted");
}

function isNotMountedError(error: unknown): boolean {
  const message = formatExecError("zfs", error).toLowerCase();
  return (
    message.includes("not currently mounted") || message.includes("not mounted")
  );
}

async function runExec(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args);
    return stdout;
  } catch (error) {
    throw new Error(formatExecError(command, error));
  }
}

export class ZfsBranchStorage implements BranchStorageBackend {
  readonly name = "zfs" as const;
  private readonly pool: string;
  private readonly datasetBase: string;
  private readonly mountBase: string;
  private readonly zfsCommand: string;
  private readonly zpoolCommand: string;

  constructor(options: ZfsBranchStorageOptions) {
    this.pool = options.pool.trim();
    this.datasetBase = normalizeDatasetBase(options.datasetBase);
    this.mountBase = options.mountBase;
    this.zfsCommand = resolveSystemCommand("zfs");
    this.zpoolCommand = resolveSystemCommand("zpool");
  }

  async assertReady(): Promise<void> {
    if (process.platform !== "linux") {
      throw new Error("ZFS storage backend is only supported on Linux");
    }

    if (this.pool.length === 0) {
      throw new Error(
        "Postgres branching needs FROST_POSTGRES_ZFS_POOL configured. Run install.sh or update.sh and set the pool in /opt/frost/.env.",
      );
    }

    await mkdir(this.mountBase, { recursive: true });

    await runExec(this.zfsCommand, ["list", "-H"]);
    await runExec(this.zpoolCommand, ["list", "-H", "-o", "name", this.pool]);

    const baseDataset = this.getBaseDatasetPath();
    const exists = await this.datasetExistsByPath(baseDataset);
    if (!exists) {
      await runExec(this.zfsCommand, ["create", "-p", baseDataset]);
    }

    if (!(await this.datasetExistsByPath(baseDataset))) {
      throw new Error(
        `Missing ZFS dataset ${baseDataset}. Run install.sh or update.sh to prepare ZFS for Postgres branching.`,
      );
    }
  }

  async createEmptyStorage(storageRef: string): Promise<BranchStorageHandle> {
    const datasetPath = this.getDatasetPath(storageRef);
    const mountPath = this.getMountPath(storageRef);

    await this.removeStorage(storageRef);
    await mkdir(dirname(mountPath), { recursive: true });
    await runExec(this.zfsCommand, buildZfsCreateArgs(datasetPath, mountPath));
    await this.mountDataset(datasetPath);

    return this.toHandle(storageRef);
  }

  async cloneStorage(
    sourceStorageRef: string,
    targetStorageRef: string,
  ): Promise<BranchStorageHandle> {
    const sourceDatasetPath = this.getDatasetPath(sourceStorageRef);
    const targetDatasetPath = this.getDatasetPath(targetStorageRef);
    const targetMountPath = this.getMountPath(targetStorageRef);

    const sourceExists = await this.datasetExistsByPath(sourceDatasetPath);
    if (!sourceExists) {
      throw new Error(`Source ZFS dataset not found: ${sourceDatasetPath}`);
    }

    await this.removeStorage(targetStorageRef);
    await mkdir(dirname(targetMountPath), { recursive: true });

    const snapshotName = `${sourceDatasetPath}@frost-${Date.now()}-${nanoid(6).toLowerCase()}`;
    await runExec(this.zfsCommand, ["snapshot", snapshotName]);

    try {
      await runExec(
        this.zfsCommand,
        buildZfsCloneArgs(snapshotName, targetDatasetPath, targetMountPath),
      );
    } catch (error) {
      await runExec(this.zfsCommand, ["destroy", snapshotName]).catch(
        () => undefined,
      );
      throw error;
    }
    await this.mountDataset(targetDatasetPath);

    return this.toHandle(targetStorageRef);
  }

  async swapStorage(
    liveStorageRef: string,
    stagedStorageRef: string,
  ): Promise<void> {
    const liveDatasetPath = this.getDatasetPath(liveStorageRef);
    const stagedDatasetPath = this.getDatasetPath(stagedStorageRef);
    const backupDatasetPath = `${liveDatasetPath}-old-${Date.now()}`;
    const liveMountPath = this.getMountPath(liveStorageRef);

    await this.unmountDataset(liveDatasetPath);
    await this.unmountDataset(stagedDatasetPath);
    await runExec(this.zfsCommand, [
      "rename",
      liveDatasetPath,
      backupDatasetPath,
    ]);

    try {
      await runExec(this.zfsCommand, [
        "rename",
        stagedDatasetPath,
        liveDatasetPath,
      ]);
      await runExec(this.zfsCommand, [
        "set",
        `mountpoint=${liveMountPath}`,
        liveDatasetPath,
      ]);
      await this.mountDataset(liveDatasetPath);
    } catch (error) {
      await runExec(this.zfsCommand, [
        "rename",
        backupDatasetPath,
        liveDatasetPath,
      ]).catch(() => undefined);
      throw error;
    }

    // If the backup cannot be destroyed (e.g. it has dependent clones) make
    // sure it never tries to mount over the live mountpoint again.
    await runExec(this.zfsCommand, [
      "set",
      "canmount=noauto",
      backupDatasetPath,
    ]).catch(() => undefined);
    await runExec(this.zfsCommand, [
      "set",
      "mountpoint=none",
      backupDatasetPath,
    ]).catch(() => undefined);

    await this.destroyDatasetWithOrigin(backupDatasetPath).catch(
      () => undefined,
    );
  }

  async removeStorage(storageRef: string): Promise<void> {
    const datasetPath = this.getDatasetPath(storageRef);
    const mountPath = this.getMountPath(storageRef);

    await this.unmountDataset(datasetPath);
    await this.destroyDatasetWithOrigin(datasetPath);
    await rm(mountPath, { recursive: true, force: true });
  }

  async assertStorageRemovable(
    storageRef: string,
    options: AssertStorageRemovableOptions = {},
  ): Promise<void> {
    const datasetPath = this.getDatasetPath(storageRef);
    let output: string;
    try {
      output = await runExec(this.zfsCommand, [
        "list",
        "-H",
        "-r",
        "-t",
        "snapshot",
        "-o",
        "name,clones",
        datasetPath,
      ]);
    } catch (error) {
      if (isDatasetNotFound(error)) {
        return;
      }
      throw error;
    }

    const blocking = findBlockingZfsClones({
      snapshots: parseZfsSnapshotClones(output),
      allowedDatasetPrefixes: (
        options.allowedDependentStorageRefPrefixes ?? []
      ).map((prefix) => this.getDatasetPath(prefix)),
    });

    if (blocking.length > 0) {
      throw new Error(
        `Storage ${storageRef} cannot be removed while other branches depend on it (${blocking.join(", ")}). Delete those branches first.`,
      );
    }
  }

  async resolveMountPath(storageRef: string): Promise<string> {
    return this.getMountPath(storageRef);
  }

  /**
   * Destroys a dataset (recursively) and then the snapshot it was cloned
   * from, so clone origins do not accumulate on the source dataset.
   */
  private async destroyDatasetWithOrigin(datasetPath: string): Promise<void> {
    let origin = "";
    try {
      origin = (
        await runExec(this.zfsCommand, [
          "get",
          "-H",
          "-o",
          "value",
          "origin",
          datasetPath,
        ])
      ).trim();
    } catch (error) {
      if (isDatasetNotFound(error)) {
        return;
      }
      throw error;
    }

    try {
      await runExec(this.zfsCommand, ["destroy", "-r", datasetPath]);
    } catch (error) {
      if (!isDatasetNotFound(error)) {
        throw error;
      }
    }

    if (!origin.includes("@frost-")) {
      return;
    }

    try {
      await runExec(this.zfsCommand, ["destroy", origin]);
    } catch (error) {
      if (!isDependentClonesError(error) && !isDatasetNotFound(error)) {
        console.warn("[zfs-branch-storage] Failed to destroy origin snapshot", {
          origin,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async datasetExistsByPath(datasetPath: string): Promise<boolean> {
    try {
      await runExec(this.zfsCommand, ["list", "-H", datasetPath]);
      return true;
    } catch {
      return false;
    }
  }

  private async unmountDataset(datasetPath: string): Promise<void> {
    try {
      await runExec(this.zfsCommand, ["unmount", datasetPath]);
    } catch (error) {
      if (!isNotMountedError(error) && !isDatasetNotFound(error)) {
        throw error;
      }
    }
  }

  private async mountDataset(datasetPath: string): Promise<void> {
    try {
      await runExec(this.zfsCommand, ["mount", datasetPath]);
    } catch (error) {
      if (!isAlreadyMountedError(error)) {
        throw error;
      }
    }
  }

  private getBaseDatasetPath(): string {
    if (this.datasetBase.length === 0) {
      return this.pool;
    }
    return `${this.pool}/${this.datasetBase}`;
  }

  private getDatasetPath(storageRef: string): string {
    return buildZfsDatasetPath(this.pool, this.datasetBase, storageRef);
  }

  private getMountPath(storageRef: string): string {
    return buildZfsMountPath(this.mountBase, storageRef);
  }

  private toHandle(storageRef: string): BranchStorageHandle {
    return {
      storageBackend: this.name,
      storageRef,
      mountPath: this.getMountPath(storageRef),
    };
  }
}
