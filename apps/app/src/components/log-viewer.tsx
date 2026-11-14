"use client";

import { ArrowDown, Check, Copy, Pause, Play, WrapText } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/time";
import { cn, copyText } from "@/lib/utils";

function parseLogLine(line: string): {
  timestamp: string | null;
  content: string;
} {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/,
  );
  if (match) {
    return { timestamp: match[1], content: match[2] };
  }
  return { timestamp: null, content: line };
}

function formatTimestamp(iso: string): string {
  return formatDateTime(iso, iso);
}

const BOTTOM_THRESHOLD_PX = 24;

interface LogViewerProps {
  logs: string[];
  error?: string | null;
  emptyMessage?: string;
  className?: string;
  /** Wrap long lines initially. Runtime logs default to off, build logs on. */
  defaultWrap?: boolean;
  /** Rendered at the start of the toolbar, e.g. a connection status. */
  toolbarStart?: React.ReactNode;
  /** Rendered before the toolbar buttons, e.g. a replica filter. */
  toolbarEnd?: React.ReactNode;
}

export type LogStreamState = "live" | "reconnecting" | "finished" | "failed";

interface LogConnectionStatusProps {
  isConnected?: boolean;
  /** Overrides isConnected, e.g. to show a finished stream. */
  state?: LogStreamState;
  className?: string;
}

const streamStateConfig: Record<
  LogStreamState,
  { label: string; dotClassName: string }
> = {
  live: {
    label: "Live",
    dotClassName: "bg-green-500 motion-safe:animate-pulse",
  },
  reconnecting: {
    label: "Reconnecting...",
    dotClassName: "bg-neutral-500 motion-safe:animate-pulse",
  },
  finished: { label: "Finished", dotClassName: "bg-neutral-500" },
  failed: { label: "Failed", dotClassName: "bg-red-500" },
};

export function LogConnectionStatus({
  isConnected = false,
  state,
  className,
}: LogConnectionStatusProps) {
  const resolved: LogStreamState =
    state ?? (isConnected ? "live" : "reconnecting");
  const config = streamStateConfig[resolved];
  return (
    <output className={cn("flex shrink-0 items-center gap-2", className)}>
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", config.dotClassName)}
      />
      <span className="text-xs text-neutral-500">{config.label}</span>
    </output>
  );
}

interface ToolbarButtonProps {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function ToolbarButton({
  label,
  pressed,
  onClick,
  disabled,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors",
        "hover:bg-neutral-800 hover:text-neutral-200",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        "disabled:pointer-events-none disabled:opacity-40",
        pressed && "bg-neutral-800 text-neutral-200",
      )}
    >
      {children}
    </button>
  );
}

export function LogViewer({
  logs,
  error,
  emptyMessage = "No logs yet...",
  className,
  defaultWrap = false,
  toolbarStart,
  toolbarEnd,
}: LogViewerProps) {
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(defaultWrap);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scrollToBottom() {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when content or wrapping changes
  useEffect(
    function followLatest() {
      if (follow) scrollToBottom();
    },
    [logs, follow, wrap],
  );

  useEffect(function clearCopiedTimeout() {
    return function cleanup() {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, []);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    // Pause when the user scrolls up; resume once they return to the bottom.
    if (isAtBottom !== follow) setFollow(isAtBottom);
  }

  function handleJumpToLatest() {
    setFollow(true);
    scrollToBottom();
  }

  function handleToggleFollow() {
    if (follow) {
      setFollow(false);
    } else {
      handleJumpToLatest();
    }
  }

  async function handleCopy() {
    if (await copyText(logs.join("\n"))) {
      setCopied(true);
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = setTimeout(function resetCopied() {
        setCopied(false);
      }, 1500);
    } else {
      toast.error("Failed to copy logs");
    }
  }

  const hasLogs = logs.length > 0;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {error && (
        <div
          role="alert"
          className="shrink-0 border-b border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-400"
        >
          {error}
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-neutral-900 bg-neutral-950 px-3">
        {toolbarStart}
        <span className="text-xs tabular-nums text-neutral-600">
          {logs.length} {logs.length === 1 ? "line" : "lines"}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {toolbarEnd ? <div className="mr-2">{toolbarEnd}</div> : null}
          <ToolbarButton
            label={wrap ? "Disable line wrap" : "Wrap lines"}
            pressed={wrap}
            onClick={function toggleWrap() {
              setWrap(!wrap);
            }}
          >
            <WrapText className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label={follow ? "Pause auto-scroll" : "Follow latest logs"}
            pressed={follow}
            onClick={handleToggleFollow}
            disabled={!hasLogs}
          >
            {follow ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </ToolbarButton>
          <ToolbarButton
            label={copied ? "Copied" : "Copy all logs"}
            onClick={handleCopy}
            disabled={!hasLogs}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </ToolbarButton>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <section
          ref={containerRef}
          onScroll={handleScroll}
          aria-label="Log output"
          className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-4 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-700"
        >
          {!hasLogs ? (
            <span className="text-neutral-600">{emptyMessage}</span>
          ) : (
            <div className={cn(!wrap && "w-max min-w-full")}>
              {logs.map((line, i) => {
                const { timestamp, content } = parseLogLine(line);
                return (
                  <div
                    key={`${i}-${line.slice(0, 50)}`}
                    className={cn(
                      "leading-5",
                      wrap
                        ? "flex whitespace-pre-wrap [overflow-wrap:anywhere]"
                        : "whitespace-pre",
                    )}
                  >
                    {timestamp && (
                      <span className="mr-3 shrink-0 select-none text-neutral-600">
                        {formatTimestamp(timestamp)}
                      </span>
                    )}
                    <span className="min-w-0 text-neutral-400">{content}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {!follow && hasLogs && (
          <button
            type="button"
            onClick={handleJumpToLatest}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900/95 px-3 py-1 text-xs text-neutral-300 shadow-lg backdrop-blur transition-colors hover:border-neutral-600 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
