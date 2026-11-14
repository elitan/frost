import type { ReactNode } from "react";

interface SettingsPageHeaderProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function SettingsPageHeader({
  title,
  description,
  action,
}: SettingsPageHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          {title}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
