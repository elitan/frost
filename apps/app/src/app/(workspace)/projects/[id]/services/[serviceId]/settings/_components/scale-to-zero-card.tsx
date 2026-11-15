"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingCard } from "@/components/setting-card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDeployService,
  useService,
  useUpdateService,
} from "@/hooks/use-services";

const SCALE_TO_ZERO_OPTIONS = [
  { value: "off", label: "Always on" },
  { value: "5", label: "After 5 minutes idle" },
  { value: "15", label: "After 15 minutes idle" },
  { value: "30", label: "After 30 minutes idle" },
  { value: "60", label: "After 1 hour idle" },
  { value: "360", label: "After 6 hours idle" },
  { value: "1440", label: "After 24 hours idle" },
];

interface ScaleToZeroCardProps {
  serviceId: string;
}

export function ScaleToZeroCard({ serviceId }: ScaleToZeroCardProps) {
  const { data: service } = useService(serviceId);
  const envId = service?.environmentId ?? "";
  const updateMutation = useUpdateService(serviceId, envId);
  const deployMutation = useDeployService(serviceId, envId);

  const [value, setValue] = useState("off");
  const initialValue = useRef("off");

  useEffect(() => {
    if (service) {
      const current = service.scaleToZeroMinutes?.toString() ?? "off";
      setValue(current);
      initialValue.current = current;
    }
  }, [service]);

  const hasChanges = value !== initialValue.current;
  const options = SCALE_TO_ZERO_OPTIONS.some((opt) => opt.value === value)
    ? SCALE_TO_ZERO_OPTIONS
    : [
        ...SCALE_TO_ZERO_OPTIONS,
        { value, label: `After ${value} minutes idle` },
      ];

  async function handleSave() {
    try {
      await updateMutation.mutateAsync({
        scaleToZeroMinutes: value === "off" ? null : Number(value),
      });
      initialValue.current = value;
      toast.success("Scale to zero saved", {
        description: "Redeploy required for changes to take effect",
        duration: 10000,
        action: {
          label: "Redeploy",
          onClick: () => deployMutation.mutateAsync(),
        },
      });
    } catch {
      toast.error("Failed to save");
    }
  }

  if (!service || service.serviceType !== "app") return null;

  return (
    <SettingCard
      title="Scale to Zero"
      description="Stop the service's containers after a period with no network traffic. The next request to one of its domains starts it again, so that request waits for the cold start. Requests from other services or straight to its port do not wake it."
      onSubmit={handleSave}
      footerRight={
        <Button
          size="sm"
          type="submit"
          disabled={updateMutation.isPending || !hasChanges}
        >
          {updateMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Save"
          )}
        </Button>
      }
    >
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingCard>
  );
}
