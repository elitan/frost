"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { BrandLockup } from "@/components/brand-lockup";
import { CommandPaletteTrigger } from "@/components/command-palette";
import { LeftMenuFooter } from "@/components/left-menu-footer";
import { ShellTopRow } from "@/components/shell-top-row";
import { SkeletonBlock } from "@/components/skeletons";
import { useProjects } from "@/hooks/use-projects";
import { cn } from "@/lib/utils";

function getActiveProjectId(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  if (!match) {
    return null;
  }
  if (match[1] === "new") {
    return null;
  }
  return match[1];
}

export function WorkspaceLeftMenu() {
  const pathname = usePathname();
  const { data: projects = [], isLoading } = useProjects();

  const activeProjectId = useMemo(
    function getCurrentProjectId() {
      return getActiveProjectId(pathname);
    },
    [pathname],
  );

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40">
      <ShellTopRow>
        <div className="flex w-full items-center justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md leading-none text-neutral-100 transition-colors hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
          >
            <BrandLockup />
          </Link>
        </div>
      </ShellTopRow>

      <div className="border-b border-neutral-800 p-3">
        <CommandPaletteTrigger className="w-full" />
      </div>

      <nav
        aria-label="Projects"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Projects
          </p>
          <Link
            href="/projects/new"
            aria-label="New project"
            title="New project"
            className="-mr-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 motion-reduce:transition-none"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        <div className="flex-1 space-y-0.5 overflow-auto px-3 py-2">
          {isLoading &&
            ["w-24", "w-32", "w-20"].map(function renderPlaceholder(width) {
              return (
                <div key={width} className="px-3 py-2" aria-hidden="true">
                  <SkeletonBlock className={`h-4 ${width}`} />
                </div>
              );
            })}
          {projects.map(function renderProject(project) {
            const isActive = activeProjectId === project.id;
            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 motion-reduce:transition-none",
                  isActive
                    ? "bg-neutral-800/80 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] font-medium",
                    isActive
                      ? "border-neutral-600 bg-neutral-900 text-neutral-200"
                      : "border-neutral-800 bg-neutral-900 text-neutral-500",
                  )}
                >
                  {project.name.charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{project.name}</span>
              </Link>
            );
          })}
          {!isLoading && projects.length === 0 && (
            <p className="px-3 py-2 text-xs text-neutral-600">
              No projects yet
            </p>
          )}
        </div>
      </nav>

      <LeftMenuFooter />
    </aside>
  );
}
