"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
  null,
);

/**
 * Owns the palette's open state and the global ⌘K / Ctrl+K shortcut.
 * Mount once near the root of the workspace shell.
 */
export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(function togglePalette() {
    setOpen(function flip(previous) {
      return !previous;
    });
  }, []);

  useEffect(
    function registerShortcut() {
      function handleKeyDown(event: KeyboardEvent) {
        if (
          event.key.toLowerCase() === "k" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          toggle();
        }
      }
      window.addEventListener("keydown", handleKeyDown);
      return function unregisterShortcut() {
        window.removeEventListener("keydown", handleKeyDown);
      };
    },
    [toggle],
  );

  const value = useMemo(
    function getValue() {
      return { open, setOpen, toggle };
    },
    [open, toggle],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteContextValue {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error(
      "useCommandPalette must be used within CommandPaletteProvider",
    );
  }
  return context;
}
