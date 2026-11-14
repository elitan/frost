"use client";

import { SettingCard } from "@/components/setting-card";
import { Button } from "@/components/ui/button";

export function SessionSection() {
  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <SettingCard
      title="Session"
      description="End your session on this device."
      footerRight={
        <Button variant="outline" onClick={handleSignOut}>
          Sign out
        </Button>
      }
    >
      <p className="text-sm text-neutral-400">
        You'll need your Frost password to sign back in.
      </p>
    </SettingCard>
  );
}
