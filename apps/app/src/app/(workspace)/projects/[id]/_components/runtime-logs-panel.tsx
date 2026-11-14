"use client";

import type { ReactNode } from "react";
import { LogConnectionStatus, LogViewer } from "@/components/log-viewer";
import { cn } from "@/lib/utils";

interface RuntimeLogsPanelProps {
  logs: string[];
  isConnected: boolean;
  error: string | null;
  headerPrefix?: ReactNode;
  headerSuffix?: ReactNode;
  emptyMessage?: string;
  className?: string;
  viewerClassName?: string;
}

export function RuntimeLogsPanel({
  logs,
  isConnected,
  error,
  headerPrefix,
  headerSuffix,
  emptyMessage = "Waiting for logs...",
  className,
  viewerClassName,
}: RuntimeLogsPanelProps) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <LogViewer
        logs={logs}
        error={error}
        emptyMessage={emptyMessage}
        className={cn(
          "overflow-hidden rounded-lg border border-neutral-800",
          viewerClassName,
        )}
        toolbarStart={
          <>
            {headerPrefix}
            <LogConnectionStatus isConnected={isConnected} />
          </>
        }
        toolbarEnd={headerSuffix}
      />
    </div>
  );
}
