"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface MobileNavContextValue {
  openNav: () => void;
}

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

interface MobileNavProps {
  sidebar: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Shows `sidebar` inline from the `lg` breakpoint up and as a slide-in
 * drawer below it. Render `MobileNavTrigger` in headers to open the drawer.
 */
export function MobileNav({
  sidebar,
  open,
  onOpenChange,
  children,
}: MobileNavProps) {
  const pathname = usePathname();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(
    function closeOnNavigate() {
      if (pathname) onOpenChangeRef.current(false);
    },
    [pathname],
  );

  const contextValue = useMemo(function getContextValue() {
    return {
      openNav: function openNav() {
        onOpenChangeRef.current(true);
      },
    };
  }, []);

  return (
    <MobileNavContext.Provider value={contextValue}>
      <div className="hidden h-full shrink-0 lg:flex">{sidebar}</div>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          className="w-72 max-w-[85vw] border-neutral-800 bg-neutral-950 p-0 lg:hidden [&>aside]:w-full [&>aside]:border-r-0"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      {children}
    </MobileNavContext.Provider>
  );
}

interface MobileNavTriggerProps {
  className?: string;
}

export function MobileNavTrigger({ className }: MobileNavTriggerProps) {
  const context = useContext(MobileNavContext);
  if (!context) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={context.openNav}
      aria-label="Open navigation"
      className={cn(
        "-ml-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 lg:hidden",
        className,
      )}
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
