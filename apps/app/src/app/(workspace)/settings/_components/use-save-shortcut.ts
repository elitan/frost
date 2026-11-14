"use client";

import { type RefObject, useEffect } from "react";

/**
 * Cmd/Ctrl+S submits the settings form that currently has focus, but only
 * when its submit button is enabled (i.e. the form is dirty and valid).
 */
export function useSaveShortcut(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "s") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;

      const active = document.activeElement;
      const container = containerRef.current;
      if (!(active instanceof HTMLElement) || !container?.contains(active))
        return;

      const form = active.closest("form");
      if (!form) return;

      event.preventDefault();
      const submitter = form.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      if (!submitter || submitter.disabled) return;
      form.requestSubmit(submitter);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [containerRef]);
}
