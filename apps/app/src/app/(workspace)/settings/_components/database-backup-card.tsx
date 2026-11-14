"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { RelativeTime } from "@/components/relative-time";
import { SettingCard } from "@/components/setting-card";
import { StatusNotice } from "@/components/status-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { orpc } from "@/lib/orpc-client";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), 4);
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 text-sm sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="min-w-0 text-neutral-200">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-neutral-500">{children}</span>;
}

const ROW_LABELS = [
  "Last snapshot",
  "Local snapshots",
  "Location",
  "Offsite copy",
] as const;

export function DatabaseBackupCard() {
  const { data } = useQuery(orpc.settings.systemBackup.queryOptions());

  const totalSize = data?.snapshots.reduce((sum, s) => sum + s.size, 0) ?? 0;

  return (
    <SettingCard
      title="Frost Database Backups"
      description="Frost snapshots its own database daily and before migrations. Daily snapshots are also uploaded to the first configured Postgres backup bucket."
    >
      <div className="space-y-4">
        <dl className="divide-y divide-neutral-800 border-y border-neutral-800">
          {data ? (
            <>
              <Row label="Last snapshot">
                {data.running ? (
                  <span className="inline-flex items-center gap-1.5 text-neutral-300">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Snapshot in progress…
                  </span>
                ) : data.lastSnapshotAt ? (
                  <RelativeTime date={data.lastSnapshotAt} />
                ) : (
                  <Muted>No snapshots yet</Muted>
                )}
              </Row>
              <Row label="Local snapshots">
                {data.snapshots.length > 0 ? (
                  <>
                    {data.snapshots.length}{" "}
                    <Muted>· {formatBytes(totalSize)}</Muted>
                  </>
                ) : (
                  <Muted>No snapshots yet</Muted>
                )}
              </Row>
              <Row label="Location">
                <code className="break-all font-mono text-xs text-neutral-300">
                  {data.localDir}
                </code>
              </Row>
              <Row label="Offsite copy">
                {data.offsiteDestination ? (
                  <div className="space-y-0.5">
                    <code className="break-all font-mono text-xs text-neutral-300">
                      {data.offsiteDestination}
                    </code>
                    <p className="text-xs text-neutral-500">
                      {data.lastOffsiteAt ? (
                        <RelativeTime
                          date={data.lastOffsiteAt}
                          prefix="Last upload"
                        />
                      ) : (
                        "No uploads yet"
                      )}
                    </p>
                  </div>
                ) : (
                  <Muted>Not configured (local only)</Muted>
                )}
              </Row>
            </>
          ) : (
            ROW_LABELS.map((label) => (
              <Row key={label} label={label}>
                <Skeleton className="h-5 w-40" />
              </Row>
            ))
          )}
        </dl>

        {data?.lastSnapshotError && (
          <StatusNotice
            tone="danger"
            role="alert"
            icon={<XCircle className="h-4 w-4" />}
            heading="Last snapshot failed"
          >
            <p className="break-words">{data.lastSnapshotError}</p>
          </StatusNotice>
        )}
        {data?.lastOffsiteError && (
          <StatusNotice
            tone="danger"
            role="alert"
            icon={<XCircle className="h-4 w-4" />}
            heading="Last offsite upload failed"
          >
            <p className="break-words">{data.lastOffsiteError}</p>
          </StatusNotice>
        )}
      </div>
    </SettingCard>
  );
}
