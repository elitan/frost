import { cn } from "@/lib/utils";

/**
 * Motion-safe shimmering placeholder block. Hidden from assistive tech;
 * wrap groups of blocks in `SkeletonStatus` (an `<output>` live region).
 */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-md bg-neutral-800/80 motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

export function SkeletonStatus({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <output
      aria-label={label}
      aria-busy="true"
      className={cn("block", className)}
    >
      {children}
      <span className="sr-only">{label}</span>
    </output>
  );
}
