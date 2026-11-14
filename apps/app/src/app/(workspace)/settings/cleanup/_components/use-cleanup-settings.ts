"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useDemoMode } from "@/hooks/use-demo-mode";
import { orpc } from "@/lib/orpc-client";

export interface CleanupResult {
  success: boolean;
  deletedImages: string[];
  deletedNetworks: string[];
  prunedContainers: number;
  prunedBuildCacheBytes: number;
  compactedDatabaseBytes?: number;
  freedBytes: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

export interface CleanupSettings {
  enabled: boolean;
  keepImages: number;
  pruneDangling: boolean;
  pruneNetworks: boolean;
  running: boolean;
  lastRun: string | null;
  lastResult: CleanupResult | null;
}

function parseResult(json: string | null): CleanupResult | null {
  if (!json) return null;
  return JSON.parse(json) as CleanupResult;
}

export function useCleanupSettings() {
  const demoMode = useDemoMode();
  const queryClient = useQueryClient();

  const { data, isError } = useQuery(orpc.cleanup.get.queryOptions());

  const { data: runStatusData } = useQuery({
    ...orpc.cleanup.runStatus.queryOptions(),
    refetchInterval: (query) => {
      const runStatus = query.state.data;
      if (runStatus) return runStatus.running ? 2000 : false;
      return data?.running ? 2000 : false;
    },
  });

  const settings: CleanupSettings | null = data
    ? {
        enabled: data.enabled,
        keepImages: data.retentionDays,
        pruneDangling: data.pruneDangling,
        pruneNetworks: data.pruneNetworks,
        running: runStatusData?.running ?? data.running,
        lastRun: runStatusData?.lastRun ?? data.lastRun,
        lastResult:
          parseResult(runStatusData?.result ?? null) ??
          parseResult(data.lastResult),
      }
    : null;

  const updateMutation = useMutation(
    orpc.cleanup.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.refetchQueries({ queryKey: orpc.cleanup.get.key() });
      },
    }),
  );

  const runMutation = useMutation(
    orpc.cleanup.runStart.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.refetchQueries({ queryKey: orpc.cleanup.get.key() }),
          queryClient.refetchQueries({
            queryKey: orpc.cleanup.runStatus.key(),
          }),
        ]);
      },
    }),
  );

  async function updateSetting(
    updates: Partial<CleanupSettings>,
  ): Promise<boolean> {
    if (demoMode) return false;
    try {
      await updateMutation.mutateAsync({
        enabled: updates.enabled,
        retentionDays: updates.keepImages,
        pruneDangling: updates.pruneDangling,
        pruneNetworks: updates.pruneNetworks,
      });
      toast.success("Cleanup settings saved");
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : "Failed to save cleanup settings",
      );
      return false;
    }
  }

  async function runCleanup(): Promise<void> {
    if (demoMode) return;
    await runMutation.mutateAsync({});
  }

  return {
    demoMode,
    settings,
    saving: updateMutation.isPending,
    error: isError ? "Failed to load cleanup settings" : "",
    updateSetting,
    runCleanup,
  };
}
