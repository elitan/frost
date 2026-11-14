"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useCommandPalette } from "./command-palette-provider";

function useModifierLabel(): string {
  // Default to ⌘ for SSR; switch after mount on non-Apple platforms.
  const [label, setLabel] = useState("⌘");
  useEffect(function detectPlatform() {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.platform;
    if (!/mac|iphone|ipad|ipod/i.test(platform)) {
      setLabel("Ctrl ");
    }
  }, []);
  return label;
}

interface CommandPaletteTriggerProps {
  className?: string;
  /** Compact renders only the icon + shortcut (for tight headers). */
  compact?: boolean;
}

export function CommandPaletteTrigger({
  className,
  compact = false,
}: CommandPaletteTriggerProps) {
  const { setOpen } = useCommandPalette();
  const modifier = useModifierLabel();

  return (
    <button
      type="button"
      onClick={function openPalette() {
        setOpen(true);
      }}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "group flex h-8 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 text-sm text-neutral-500 transition-colors hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 motion-reduce:transition-none",
        className,
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className={cn("flex-1 text-left", compact && "sr-only")}>
        Search…
      </span>
      <kbd className="pointer-events-none rounded border border-neutral-800 bg-neutral-950 px-1.5 py-px font-sans text-[10px] font-medium text-neutral-500 group-hover:text-neutral-400">
        {modifier}K
      </kbd>
    </button>
  );
}
