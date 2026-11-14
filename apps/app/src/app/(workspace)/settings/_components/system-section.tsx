"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DemoModeAlert } from "@/components/demo-mode-alert";
import { RelativeTime } from "@/components/relative-time";
import { SettingCard } from "@/components/setting-card";
import { StatusNotice } from "@/components/status-notice";
import { Button } from "@/components/ui/button";
import { useDemoMode } from "@/hooks/use-demo-mode";
import { orpc } from "@/lib/orpc-client";

type CheckState =
  | "loading"
  | "checking"
  | "unchecked"
  | "latest"
  | "available"
  | "error";

const PILL_STYLES: Record<CheckState, string> = {
  loading: "border-neutral-800 text-neutral-500",
  checking: "border-neutral-700 text-neutral-300",
  unchecked: "border-neutral-700 text-neutral-400",
  latest: "border-green-900/60 bg-green-900/20 text-green-400",
  available: "border-blue-900/60 bg-blue-900/20 text-blue-400",
  error: "border-red-900/60 bg-red-900/20 text-red-400",
};

function UpdateStatusPill({ state }: { state: CheckState }) {
  const content: Record<CheckState, React.ReactNode> = {
    loading: <span className="w-16" />,
    checking: (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking for updates…
      </>
    ),
    unchecked: (
      <>
        <Circle className="h-3.5 w-3.5" />
        Not checked yet
      </>
    ),
    latest: (
      <>
        <CheckCircle2 className="h-3.5 w-3.5" />
        Up to date
      </>
    ),
    available: (
      <>
        <ArrowUpCircle className="h-3.5 w-3.5" />
        Update available
      </>
    ),
    error: (
      <>
        <XCircle className="h-3.5 w-3.5" />
        Check failed
      </>
    ),
  };

  return (
    <output
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${PILL_STYLES[state]}`}
    >
      {content[state]}
    </output>
  );
}

type UpdateState = "idle" | "preparing" | "restarting" | "success" | "failed";

export function SystemSection() {
  const demoMode = useDemoMode();
  const queryClient = useQueryClient();
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [previousVersion, setPreviousVersion] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState("");
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const previousVersionRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const { data: status } = useQuery(orpc.updates.get.queryOptions());

  const { data: updateResult, refetch: refetchResult } = useQuery({
    ...orpc.updates.getResult.queryOptions(),
    refetchInterval: updateState === "restarting" ? 2000 : false,
    retry: updateState === "restarting",
  });

  const { refetch: refetchHealth } = useQuery({
    ...orpc.health.check.queryOptions(),
    enabled: updateState === "restarting",
    refetchInterval: updateState === "restarting" ? 2000 : false,
    retry: false,
  });

  const checkMutation = useMutation(
    orpc.updates.check.mutationOptions({
      onSuccess: async () => {
        await queryClient.refetchQueries({ queryKey: orpc.updates.get.key() });
      },
      onError: (err) => {
        setError(
          err instanceof Error && err.message
            ? `Couldn't check for updates: ${err.message}`
            : "Couldn't check for updates",
        );
      },
    }),
  );

  const applyMutation = useMutation(
    orpc.updates.apply.mutationOptions({
      onSuccess: () => {
        setUpdateState("restarting");
        pollForRestart();
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : "Failed to apply update");
        setUpdateState("idle");
      },
    }),
  );

  const clearResultMutation = useMutation(
    orpc.updates.clearResult.mutationOptions(),
  );

  function stopPolling() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function pollForRestart() {
    stopPolling();
    const startTime = Date.now();
    const maxDuration = 300000;
    const expectedPreviousVersion = previousVersionRef.current;

    const schedule = () => {
      if (!mountedRef.current) return;
      pollTimerRef.current = setTimeout(poll, 2000);
    };

    const markSuccess = async () => {
      setUpdateState("success");
      await queryClient.refetchQueries({
        queryKey: orpc.updates.get.key(),
      });
    };

    const poll = async () => {
      pollTimerRef.current = null;
      if (!mountedRef.current) return;

      if (Date.now() - startTime > maxDuration) {
        setUpdateState("failed");
        setError("Server did not respond after 5 minutes");
        return;
      }

      try {
        const healthRes = await refetchHealth();
        const resultRes = await refetchResult();
        if (!mountedRef.current) return;

        const result = resultRes.isError ? undefined : resultRes.data;

        if (result?.completed && result.success) {
          await markSuccess();
          return;
        }
        if (result?.completed && !result.success) {
          setUpdateState("failed");
          setShowLog(true);
          return;
        }

        const health = healthRes.isError ? undefined : healthRes.data;
        if (
          health?.ok &&
          health.version &&
          expectedPreviousVersion &&
          health.version !== expectedPreviousVersion
        ) {
          await markSuccess();
          return;
        }
      } catch {}

      schedule();
    };

    schedule();
  }

  // Never checked: check once automatically so the status is meaningful.
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (!status || status.lastCheck || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    checkMutation.mutate({});
  }, [status, checkMutation]);

  async function handleCheck() {
    setError("");
    checkMutation.mutate({});
  }

  function handleApply() {
    if (demoMode) return;
    setPreviousVersion(status?.currentVersion || null);
    previousVersionRef.current = status?.currentVersion || null;
    setUpdateState("preparing");
    setError("");
    setShowLog(false);
    setShowApplyDialog(false);

    applyMutation.mutate({});
  }

  async function handleDismiss() {
    await clearResultMutation.mutateAsync({});
    setUpdateState("idle");
    setShowLog(false);
    setPreviousVersion(null);
  }

  const isUpdating =
    updateState === "preparing" || updateState === "restarting";

  return (
    <SettingCard
      title="System"
      description="The Frost version you're running and available updates."
      footerLeft={
        updateState === "idle" ? (
          <span className="text-sm text-neutral-500">
            {status?.lastCheck ? (
              <RelativeTime date={status.lastCheck} prefix="Checked" />
            ) : status ? (
              "Not checked yet"
            ) : null}
          </span>
        ) : undefined
      }
      footer={
        updateState === "success" || updateState === "failed" ? (
          <Button variant="secondary" onClick={handleDismiss}>
            Dismiss
          </Button>
        ) : status?.updateAvailable ? (
          <Button
            onClick={() => setShowApplyDialog(true)}
            disabled={demoMode || isUpdating}
          >
            {isUpdating ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                {updateState === "preparing" ? "Preparing..." : "Restarting..."}
              </>
            ) : (
              "Update now"
            )}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={handleCheck}
            disabled={checkMutation.isPending}
          >
            {checkMutation.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Checking...
              </>
            ) : (
              <>
                <RefreshCw className="mr-1.5 h-4 w-4" />
                Check for updates
              </>
            )}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {demoMode && (
          <DemoModeAlert text="System updates are locked in demo mode." />
        )}

        {updateState === "restarting" && (
          <StatusNotice
            tone="info"
            icon={<Loader2 className="h-5 w-5 animate-spin" />}
            heading="Server restarting..."
          >
            <p>This may take up to 2 minutes.</p>
          </StatusNotice>
        )}

        {updateState === "success" && (
          <StatusNotice
            tone="success"
            icon={<CheckCircle2 className="h-5 w-5" />}
            heading="Update complete!"
          >
            {previousVersion &&
              (updateResult?.newVersion || status?.currentVersion) &&
              previousVersion !==
                (updateResult?.newVersion || status?.currentVersion) && (
                <p>
                  v{previousVersion} → v
                  {updateResult?.newVersion || status?.currentVersion}
                </p>
              )}
            {updateResult?.log && (
              <button
                type="button"
                onClick={() => setShowLog(!showLog)}
                className="mt-2 flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-300"
              >
                {showLog ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                View update log
              </button>
            )}
          </StatusNotice>
        )}

        {updateState === "failed" && (
          <StatusNotice
            tone="danger"
            icon={<XCircle className="h-5 w-5" />}
            heading="Update failed"
          >
            {error ? <p>{error}</p> : null}
            {updateResult?.log && (
              <button
                type="button"
                onClick={() => setShowLog(!showLog)}
                className="mt-2 flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-300"
              >
                {showLog ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                View update log
              </button>
            )}
          </StatusNotice>
        )}

        {showLog && updateResult?.log && (
          <pre className="max-h-64 overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-300">
            {/* biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes */}
            {updateResult.log.replace(/\x1b\[[0-9;]*m/g, "")}
          </pre>
        )}

        {updateState === "idle" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-neutral-400">Current version</p>
                <p className="mt-1 h-7 font-mono text-lg font-medium text-neutral-100">
                  {status?.currentVersion ? `v${status.currentVersion}` : ""}
                </p>
              </div>
              <UpdateStatusPill
                state={
                  checkMutation.isPending
                    ? "checking"
                    : error
                      ? "error"
                      : !status
                        ? "loading"
                        : status.updateAvailable
                          ? "available"
                          : status.lastCheck
                            ? "latest"
                            : "unchecked"
                }
              />
            </div>

            {status?.updateAvailable && status.latestVersion && (
              <StatusNotice
                tone="info"
                heading={`Update available: v${status.latestVersion}`}
              >
                {status.changelog?.includes("MIGRATIONS") && (
                  <div className="mt-3 flex items-start gap-2 rounded bg-yellow-900/30 p-2 text-yellow-400">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="text-xs">
                      This update includes database migrations. Back up your
                      data before updating.
                    </p>
                  </div>
                )}
              </StatusNotice>
            )}

            {error && (
              <p role="alert" className="text-sm text-red-400">
                {error}
              </p>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={showApplyDialog}
        onOpenChange={setShowApplyDialog}
        title="Apply update"
        description="This will restart Frost to apply the update. Continue?"
        confirmLabel="Update and restart"
        loading={applyMutation.isPending || updateState === "preparing"}
        onConfirm={handleApply}
      />
    </SettingCard>
  );
}
