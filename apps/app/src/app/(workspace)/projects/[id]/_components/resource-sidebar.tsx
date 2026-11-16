"use client";

import { X } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { MobileNavTrigger } from "@/components/mobile-nav";
import { StateTabs } from "@/components/state-tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ResourceSidebarTab<T extends string> {
  id: T;
  label: string;
}

export type ResourceContentMode = "full" | "center";

interface ResourceSidebarProps<T extends string> {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon: React.ReactNode;
  tabs: ResourceSidebarTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  contentMode?: ResourceContentMode;
  children: React.ReactNode;
}

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function shouldIgnoreEscape(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return true;
  }
  if (isEditableElement(document.activeElement)) return true;
  // Let open dialogs, menus and selects handle Escape themselves.
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

function useCloseOnEscape(enabled: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(
    function listenForEscape() {
      if (!enabled) return;
      function handleKeyDown(event: KeyboardEvent) {
        if (event.key !== "Escape" || shouldIgnoreEscape(event)) return;
        onCloseRef.current();
      }
      document.addEventListener("keydown", handleKeyDown);
      return function cleanup() {
        document.removeEventListener("keydown", handleKeyDown);
      };
    },
    [enabled],
  );
}

function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(function markEntered() {
    const frame = requestAnimationFrame(function enter() {
      setEntered(true);
    });
    return function cleanup() {
      cancelAnimationFrame(frame);
    };
  }, []);
  return entered;
}

export function ResourceSidebar<T extends string>({
  isOpen,
  onClose,
  title,
  icon,
  tabs,
  activeTab,
  onTabChange,
  contentMode = "full",
  children,
}: ResourceSidebarProps<T>) {
  useCloseOnEscape(isOpen, onClose);
  const entered = useEntered();
  const contentRef = useRef<HTMLDivElement>(null);

  function handleTabChange(tab: T) {
    // Start each tab at the top so switching never lands mid-scroll.
    if (contentRef.current) contentRef.current.scrollTop = 0;
    onTabChange(tab);
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out",
        entered ? "opacity-100" : "translate-x-3 opacity-0",
      )}
    >
      <div className="flex h-14 flex-row items-center justify-between border-b border-neutral-800 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <MobileNavTrigger className="-mr-1" />
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-400">
            {icon}
          </div>
          <h2 className="truncate text-lg font-semibold text-neutral-200">
            {title}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Close panel"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <StateTabs
          tabs={tabs}
          value={activeTab}
          onChange={handleTabChange}
          layoutId="sidebar-tabs"
        />
        <div
          ref={contentRef}
          className="flex min-h-0 flex-1 flex-col overflow-auto p-3 sm:p-4 [scrollbar-gutter:stable]"
        >
          {contentMode === "center" ? (
            <div className="mx-auto w-full max-w-[1200px]">{children}</div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}
