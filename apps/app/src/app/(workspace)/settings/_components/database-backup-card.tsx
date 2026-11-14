"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SettingCard } from "@/components/setting-card";
import { orpc } from "@/lib/orpc-client";
import { formatDateTime } from "@/lib/time";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-neutral-400">{label}</span>
      <span className="text-right text-neutral-200 break-all">{value}</span>
    </div>
  );
}

export function DatabaseBackupCard() {
  const { data } = useQuery(orpc.settings.systemBackup.queryOptions());

  return (
    <SettingCard
      title="Frost Database Backups"
      description="Frost snapshots its own database daily and before migrations. Daily snapshots are also uploaded to the first configured Postgres backup bucket."
    >
      {data ? (
        <div className="space-y-2">
          <Row
            label="Last local snapshot"
            value={
              data.lastSnapshotAt
                ? formatDateTime(data.lastSnapshotAt)
                : "Never"
            }
          />
          <Row label="Local snapshots" value={data.snapshots.length} />
          <Row label="Location" value={data.localDir} />
          <Row
            label="Offsite"
            value={data.offsiteDestination ?? "Not configured (local only)"}
          />
          {data.offsiteDestination && (
            <Row
              label="Last offsite upload"
              value={
                data.lastOffsiteAt
                  ? formatDateTime(data.lastOffsiteAt)
                  : "Never"
              }
            />
          )}
          {data.lastSnapshotError && (
            <p className="text-sm text-red-400">
              Snapshot error: {data.lastSnapshotError}
            </p>
          )}
          {data.lastOffsiteError && (
            <p className="text-sm text-red-400">
              Offsite upload error: {data.lastOffsiteError}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-neutral-400">Loading...</p>
      )}
    </SettingCard>
  );
}
