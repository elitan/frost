"use client";

import { useNow } from "@/hooks/use-now";
import { formatDateTime, getTimeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

interface RelativeTimeProps {
  date: number | string | Date;
  className?: string;
  prefix?: string;
}

function toDate(value: number | string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Live "just now / 2m ago" label that re-renders on a shared clock, with the
 * absolute timestamp available as a tooltip.
 */
export function RelativeTime({ date, className, prefix }: RelativeTimeProps) {
  const value = toDate(date);
  const time = value.getTime();
  const isRecent = Number.isFinite(time) && Date.now() - time < 60_000;
  // Subscribe to the shared clock: tick every second while "just now" is
  // shown so it flips to "1m ago" on time, otherwise once a minute.
  useNow(isRecent ? "second" : "minute");

  if (!Number.isFinite(time)) return null;

  const absolute = formatDateTime(value);

  return (
    <time
      dateTime={value.toISOString()}
      title={absolute}
      className={cn("tabular-nums", className)}
      suppressHydrationWarning
    >
      {prefix ? `${prefix} ` : null}
      {getTimeAgo(value)}
    </time>
  );
}
