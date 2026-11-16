import type { ReactNode } from "react";
import { MobileNavTrigger } from "./mobile-nav";
import { ShellTopRow } from "./shell-top-row";

interface MainContentHeaderProps {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function MainContentHeader({
  title,
  actions,
  className,
}: MainContentHeaderProps) {
  return (
    <ShellTopRow className={className}>
      <div className="flex w-full items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MobileNavTrigger />
          <div className="min-w-0 truncate text-base font-semibold text-neutral-200">
            {title}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </ShellTopRow>
  );
}
