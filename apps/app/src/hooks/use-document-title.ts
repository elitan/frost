"use client";

import { useEffect, useId } from "react";

const APP_NAME = "Frost";
const SEPARATOR = " · ";

interface TitleEntry {
  title: string;
  fallback: boolean;
}

// Registered titles, in mount order. The most recently registered
// non-fallback title wins; fallback titles (set by layouts) only apply when
// no page has claimed the title. This lets a layout provide a sensible
// default for every route while pages can still override it, regardless of
// React's child-before-parent effect ordering.
const entries = new Map<string, TitleEntry>();

let desiredTitle: string | null = null;
let observer: MutationObserver | null = null;

// Next.js renders the root `metadata.title` through React's hoisted <title>,
// which can commit after our effects (streamed metadata) and on navigations.
// Watch <head> and restore the desired title whenever something resets it.
function ensureObserver(): void {
  if (observer || typeof MutationObserver === "undefined") {
    return;
  }
  observer = new MutationObserver(function restoreTitle() {
    if (desiredTitle && document.title !== desiredTitle) {
      document.title = desiredTitle;
    }
  });
  observer.observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

function applyTitle(): void {
  let primary: string | null = null;
  let fallback: string | null = null;
  for (const entry of entries.values()) {
    if (entry.fallback) {
      fallback = entry.title;
    } else {
      primary = entry.title;
    }
  }
  const title = primary ?? fallback;
  if (!title) {
    desiredTitle = null;
    observer?.disconnect();
    observer = null;
    document.title = APP_NAME;
    return;
  }
  desiredTitle = `${title}${SEPARATOR}${APP_NAME}`;
  ensureObserver();
  if (document.title !== desiredTitle) {
    document.title = desiredTitle;
  }
}

export function formatTitleSegments(
  segments: Array<string | null | undefined>,
): string | null {
  const parts = segments.filter(function isPresent(segment): segment is string {
    return typeof segment === "string" && segment.length > 0;
  });
  return parts.length > 0 ? parts.join(" / ") : null;
}

interface UseDocumentTitleOptions {
  /** Layout-level default; any non-fallback title set by a page wins. */
  fallback?: boolean;
}

/**
 * Sets `document.title` to `"<title> · Frost"` while the component is mounted.
 * Pass `null` to skip (e.g. while data is loading) without clearing others.
 */
export function useDocumentTitle(
  title: string | null | undefined,
  options?: UseDocumentTitleOptions,
): void {
  const id = useId();
  const fallback = options?.fallback ?? false;

  useEffect(
    function syncDocumentTitle() {
      if (!title) {
        return;
      }
      entries.delete(id);
      entries.set(id, { title, fallback });
      applyTitle();
      return function clearDocumentTitle() {
        entries.delete(id);
        applyTitle();
      };
    },
    [id, title, fallback],
  );
}
