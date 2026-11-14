import type { Kysely, Selectable, Updateable } from "kysely";
import { db } from "./db";
import type { DB, Deployments } from "./db-types";

export type DeploymentStatusValue = Selectable<Deployments>["status"];

export const IN_PROGRESS_DEPLOYMENT_STATUSES = [
  "pending",
  "cloning",
  "pulling",
  "building",
  "deploying",
] as const satisfies readonly DeploymentStatusValue[];

export type DeploymentTransitionFields = Omit<
  Updateable<Deployments>,
  "id" | "status"
>;

export interface DeploymentTransitionOptions {
  /** Run inside an existing transaction. */
  executor?: Kysely<DB>;
  /** Only apply while the row still points at this container. */
  expectedContainerId?: string;
}

/**
 * Compare-and-set for deployments.status: the update only applies while the
 * row is still in one of `fromStatuses`, so concurrent writers (deployer,
 * cancellation, reconciler) cannot overwrite a newer state.
 * Returns whether the transition was applied.
 */
export async function transitionDeploymentStatus(
  deploymentId: string,
  fromStatuses: readonly DeploymentStatusValue[],
  toStatus: DeploymentStatusValue,
  extraFields: DeploymentTransitionFields = {},
  options: DeploymentTransitionOptions = {},
): Promise<boolean> {
  if (fromStatuses.length === 0) {
    return false;
  }

  let query = (options.executor ?? db)
    .updateTable("deployments")
    .set({ ...extraFields, status: toStatus })
    .where("id", "=", deploymentId)
    .where("status", "in", [...fromStatuses]);

  if (options.expectedContainerId !== undefined) {
    query = query.where("containerId", "=", options.expectedContainerId);
  }

  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}
