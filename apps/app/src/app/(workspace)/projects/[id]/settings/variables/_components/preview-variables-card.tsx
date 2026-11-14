"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EnvVarEditor } from "@/components/env-var-editor";
import { SettingCard } from "@/components/setting-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useProject, useUpdateProject } from "@/hooks/use-projects";
import type { EnvVar } from "@/lib/api";

interface PreviewVariablesCardProps {
  projectId: string;
}

export function PreviewVariablesCard({ projectId }: PreviewVariablesCardProps) {
  const { data: project } = useProject(projectId);
  const updateMutation = useUpdateProject(projectId);

  const [inherit, setInherit] = useState(false);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [hasValidationErrors, setHasValidationErrors] = useState(false);
  const initial = useRef<{ inherit: boolean; envVars: EnvVar[] }>({
    inherit: false,
    envVars: [],
  });
  const initialized = useRef(false);

  useEffect(() => {
    if (project && !initialized.current) {
      const vars: EnvVar[] = project.previewEnvVars
        ? JSON.parse(project.previewEnvVars)
        : [];
      const inheritValue = Boolean(project.previewInheritEnvVars);
      setEnvVars(vars);
      setInherit(inheritValue);
      initial.current = { inherit: inheritValue, envVars: vars };
      initialized.current = true;
    }
  }, [project]);

  const hasChanges =
    inherit !== initial.current.inherit ||
    JSON.stringify(envVars) !== JSON.stringify(initial.current.envVars);

  async function handleSave() {
    const validEnvVars = envVars
      .map((v) => ({ ...v, key: v.key.trim() }))
      .filter((v) => v.key !== "");
    try {
      await updateMutation.mutateAsync({
        previewInheritEnvVars: inherit,
        previewEnvVars: validEnvVars,
      });
      initial.current = { inherit, envVars: validEnvVars };
      setEnvVars(validEnvVars);
      toast.success("Preview variables saved", {
        description: "Applies to the next preview deployment",
      });
    } catch {
      toast.error("Failed to save");
    }
  }

  if (!project) return null;

  return (
    <SettingCard
      title="Preview Variables"
      description="Used by pull-request preview environments instead of the project variables above."
      onSubmit={handleSave}
      footerRight={
        <Button
          size="sm"
          type="submit"
          disabled={
            updateMutation.isPending || !hasChanges || hasValidationErrors
          }
        >
          {updateMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Save"
          )}
        </Button>
      }
    >
      <div className="mb-6 flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-800/30 p-3">
        <div className="space-y-1">
          <Label
            htmlFor="preview-inherit-env-vars"
            className="text-sm text-neutral-200"
          >
            Inherit project variables
          </Label>
          <p
            id="preview-inherit-env-vars-hint"
            className="text-xs text-neutral-500"
          >
            When on, previews also get the project variables above, with the
            values below taking precedence.
          </p>
        </div>
        <Switch
          id="preview-inherit-env-vars"
          checked={inherit}
          onCheckedChange={setInherit}
          aria-describedby="preview-inherit-env-vars-hint"
          className="mt-0.5 shrink-0"
        />
      </div>
      <EnvVarEditor
        value={envVars}
        onChange={setEnvVars}
        onValidationChange={setHasValidationErrors}
      />
    </SettingCard>
  );
}
