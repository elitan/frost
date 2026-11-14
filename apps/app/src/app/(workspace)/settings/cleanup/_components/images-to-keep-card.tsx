"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingCard } from "@/components/setting-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CleanupSettings } from "./use-cleanup-settings";

const MIN_IMAGES = 1;
const MAX_IMAGES = 10;

interface ImagesToKeepCardProps {
  settings: CleanupSettings;
  saving: boolean;
  demoMode?: boolean;
  onUpdate: (updates: Partial<CleanupSettings>) => Promise<boolean>;
}

export function ImagesToKeepCard({
  settings,
  saving,
  demoMode = false,
  onUpdate,
}: ImagesToKeepCardProps) {
  const [value, setValue] = useState(String(settings.keepImages));
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setValue(String(settings.keepImages));
  }, [settings.keepImages]);

  const parsed = Number.parseInt(value, 10);
  const isValid =
    Number.isInteger(parsed) && parsed >= MIN_IMAGES && parsed <= MAX_IMAGES;
  const isDirty = isValid && parsed !== settings.keepImages;

  async function handleSave() {
    if (!isDirty) return;
    setPending(true);
    try {
      await onUpdate({ keepImages: parsed });
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingCard
      title="Images to Keep"
      description="Number of Docker images to retain per service. Older images beyond this limit will be deleted during cleanup."
      onSubmit={handleSave}
      footerLeft={
        <span className="text-sm text-neutral-500">
          Valid range: {MIN_IMAGES}-{MAX_IMAGES} images
        </span>
      }
      footerRight={
        <Button
          size="sm"
          type="submit"
          disabled={demoMode || saving || !isDirty}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <Input
          id="cleanup-keep-images"
          type="number"
          min={MIN_IMAGES}
          max={MAX_IMAGES}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={demoMode}
          aria-label="Images to keep per service"
          aria-invalid={value !== "" && !isValid}
          className="w-24"
        />
        <span className="text-sm text-neutral-500">images per service</span>
      </div>
    </SettingCard>
  );
}
