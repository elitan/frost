"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/utils";

export function CopyButton({ value }: { value: string }) {
  async function handleCopy() {
    if (await copyText(value)) {
      toast.success("Copied");
    } else {
      toast.error("Failed to copy");
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={handleCopy}
      title="Copy"
      aria-label="Copy"
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  );
}

export function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-neutral-800 py-2 last:border-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <code className="truncate text-xs text-neutral-200">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
