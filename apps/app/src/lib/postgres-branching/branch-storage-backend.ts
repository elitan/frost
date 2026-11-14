export type BranchStorageBackendName = "apfs" | "copy" | "zfs";

export interface BranchStorageMetadata {
  storageBackend: BranchStorageBackendName;
  storageRef: string;
}

export interface BranchStorageHandle extends BranchStorageMetadata {
  mountPath: string;
}

export interface AssertStorageRemovableOptions {
  /** Dependents whose storageRef starts with one of these are ignored. */
  allowedDependentStorageRefPrefixes?: string[];
}

export interface BranchStorageBackend {
  readonly name: BranchStorageBackendName;
  assertReady(): Promise<void>;
  createEmptyStorage(storageRef: string): Promise<BranchStorageHandle>;
  cloneStorage(
    sourceStorageRef: string,
    targetStorageRef: string,
  ): Promise<BranchStorageHandle>;
  swapStorage(liveStorageRef: string, stagedStorageRef: string): Promise<void>;
  removeStorage(storageRef: string): Promise<void>;
  /**
   * Throws a descriptive error when removeStorage would fail because other
   * storage depends on this one (e.g. ZFS clones). Call before stopping
   * containers so a failed removal does not leave the target down.
   */
  assertStorageRemovable(
    storageRef: string,
    options?: AssertStorageRemovableOptions,
  ): Promise<void>;
  resolveMountPath(storageRef: string): Promise<string>;
}
