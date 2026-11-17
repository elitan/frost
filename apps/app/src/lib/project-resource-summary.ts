import type {
  ServiceAttentionStatus,
  ServiceRuntimeStatus,
} from "./service-runtime-status";

interface ProjectResourceItem {
  runtimeStatus: ServiceRuntimeStatus;
  attentionStatus: ServiceAttentionStatus;
}

export interface ProjectResourceSummary {
  serviceCount: number;
  databaseCount: number;
  objectStorageCount: number;
  totalCount: number;
  onlineCount: number;
  /** Scale-to-zero resources that are stopped and wake on traffic. */
  sleepingCount: number;
  attentionCount: number;
}

export type ProjectResourceSummaryTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger";

function countByStatus(
  resources: ProjectResourceItem[],
  status: ServiceRuntimeStatus,
): number {
  return resources.filter(function hasStatus(resource) {
    return resource.runtimeStatus === status;
  }).length;
}

function countAttention(resources: ProjectResourceItem[]): number {
  return resources.filter(function hasAttention(resource) {
    return resource.attentionStatus !== null;
  }).length;
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function getProjectResourceSummary(input: {
  services: ProjectResourceItem[];
  databases: ProjectResourceItem[];
  objectStorages?: ProjectResourceItem[];
}): ProjectResourceSummary {
  const serviceCount = input.services.length;
  const databaseCount = input.databases.length;
  const objectStorageCount = input.objectStorages?.length ?? 0;
  const resources = [
    ...input.services,
    ...input.databases,
    ...(input.objectStorages ?? []),
  ];

  return {
    serviceCount,
    databaseCount,
    objectStorageCount,
    totalCount: serviceCount + databaseCount + objectStorageCount,
    onlineCount: countByStatus(resources, "online"),
    sleepingCount: countByStatus(resources, "sleeping"),
    attentionCount: countAttention(resources),
  };
}

export function getProjectResourceSummaryTone(
  summary: ProjectResourceSummary,
): ProjectResourceSummaryTone {
  if (summary.totalCount === 0) {
    return "neutral";
  }

  // Sleeping (scale-to-zero) resources are healthy; they wake on traffic.
  const healthyCount = summary.onlineCount + summary.sleepingCount;

  if (healthyCount === summary.totalCount && summary.attentionCount === 0) {
    return "success";
  }

  if (healthyCount === 0) {
    return "danger";
  }

  return "warning";
}

export function formatProjectResourceBreakdown(
  summary: ProjectResourceSummary,
): string {
  if (summary.totalCount === 0) {
    return "0 resources";
  }

  const parts: string[] = [];

  if (summary.serviceCount > 0) {
    parts.push(formatCount(summary.serviceCount, "service"));
  }

  if (summary.databaseCount > 0) {
    parts.push(formatCount(summary.databaseCount, "database"));
  }

  if (summary.objectStorageCount > 0) {
    parts.push(formatCount(summary.objectStorageCount, "object storage"));
  }

  return parts.join(", ");
}
