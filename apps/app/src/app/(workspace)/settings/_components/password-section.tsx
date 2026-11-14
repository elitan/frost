"use client";

import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DemoModeAlert } from "@/components/demo-mode-alert";
import { SettingCard } from "@/components/setting-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDemoMode } from "@/hooks/use-demo-mode";
import { orpc } from "@/lib/orpc-client";

export function PasswordSection() {
  const demoMode = useDemoMode();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const mutation = useMutation(
    orpc.settings.changePassword.mutationOptions({
      onSuccess() {
        toast.success("Password updated");
        setCurrentPassword("");
        setNewPassword("");
      },
      onError(error) {
        toast.error(error.message || "Failed to update password");
      },
    }),
  );

  function handleSave() {
    if (demoMode) {
      toast.error("Password changes disabled in demo mode");
      return;
    }

    if (newPassword.length < 12) {
      toast.error("New password must be at least 12 characters");
      return;
    }
    mutation.mutate({ currentPassword, newPassword });
  }

  return (
    <SettingCard
      title="Password"
      description="Change your login password."
      onSubmit={handleSave}
      footerRight={
        <Button
          size="sm"
          type="submit"
          disabled={
            demoMode || mutation.isPending || !currentPassword || !newPassword
          }
        >
          {mutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Save"
          )}
        </Button>
      }
    >
      <div className="space-y-4">
        {demoMode && (
          <DemoModeAlert text="Password changes are locked in demo mode." />
        )}
        <div className="grid gap-2">
          <Label
            htmlFor="current-password"
            className="text-sm text-neutral-400"
          >
            Current password
          </Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={demoMode}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="new-password" className="text-sm text-neutral-400">
            New password
          </Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={demoMode}
            aria-describedby="new-password-hint"
          />
          <p id="new-password-hint" className="text-xs text-neutral-500">
            At least 12 characters.
          </p>
        </div>
      </div>
    </SettingCard>
  );
}
