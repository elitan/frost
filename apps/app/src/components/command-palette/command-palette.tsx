"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Box,
  CornerDownLeft,
  Database,
  FolderGit2,
  Globe,
  Home,
  KeyRound,
  Layers,
  type LucideIcon,
  Package,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Variable,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDatabases } from "@/hooks/use-databases";
import { useObjectStorages } from "@/hooks/use-object-storages";
import { useProjects } from "@/hooks/use-projects";
import { orpc } from "@/lib/orpc-client";
import { cn } from "@/lib/utils";
import { useCommandPalette } from "./command-palette-provider";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
  icon: LucideIcon;
  href?: string;
  perform?: () => void;
}

interface CommandGroup {
  id: string;
  heading: string;
  items: CommandItem[];
}

interface CommandPaletteProps {
  /** Current project, when the palette is opened inside a project. */
  projectId?: string | null;
  projectName?: string | null;
  /** Current environment (used for resource links). */
  environmentId?: string | null;
  onAddService?: () => void;
  onCreateEnvironment?: () => void;
}

const MAX_ITEMS_PER_GROUP_WHEN_EMPTY = 6;

const SETTINGS_PAGES: Array<{
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  keywords: string[];
}> = [
  {
    id: "general",
    label: "General",
    href: "/settings",
    icon: Settings,
    keywords: ["settings", "password", "session", "update", "backup"],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    href: "/settings/monitoring",
    icon: Activity,
    keywords: ["settings", "metrics", "cpu", "memory", "alerts"],
  },
  {
    id: "domain",
    label: "Domain & SSL",
    href: "/settings/domain",
    icon: Globe,
    keywords: ["settings", "dns", "https", "certificate", "wildcard"],
  },
  {
    id: "registries",
    label: "Registries",
    href: "/settings/registries",
    icon: Package,
    keywords: ["settings", "docker", "container", "images"],
  },
  {
    id: "api-keys",
    label: "API Keys",
    href: "/settings/api-keys",
    icon: KeyRound,
    keywords: ["settings", "tokens", "access"],
  },
  {
    id: "github",
    label: "GitHub",
    href: "/settings/github",
    icon: FolderGit2,
    keywords: ["settings", "git", "repository", "app"],
  },
  {
    id: "cleanup",
    label: "Cleanup",
    href: "/settings/cleanup",
    icon: Trash2,
    keywords: ["settings", "disk", "prune", "images", "storage"],
  },
];

/**
 * Score how well `item` matches `query`. Every whitespace-separated token must
 * appear in the label or keywords (case-insensitive). Label prefix and word
 * starts rank above plain substring matches; keyword-only matches rank last.
 * Returns -1 when the item doesn't match.
 */
function scoreItem(item: CommandItem, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const label = item.label.toLowerCase();
  const haystack = [label, item.hint ?? "", ...(item.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (label.startsWith(token)) {
      score += 4;
    } else if (label.includes(` ${token}`) || label.includes(`/${token}`)) {
      score += 3;
    } else if (label.includes(token)) {
      score += 2;
    } else if (haystack.includes(token)) {
      score += 1;
    } else {
      return -1;
    }
  }
  return score;
}

function getOptionId(baseId: string, item: CommandItem): string {
  return `${baseId}-option-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function filterGroups(groups: CommandGroup[], query: string): CommandGroup[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return groups
    .map(function filterGroup(group) {
      if (tokens.length === 0) {
        return {
          ...group,
          items: group.items.slice(0, MAX_ITEMS_PER_GROUP_WHEN_EMPTY),
        };
      }
      const scored = group.items
        .map(function score(item, index) {
          return { item, index, score: scoreItem(item, tokens) };
        })
        .filter(function matches(entry) {
          return entry.score >= 0;
        })
        .sort(function byScore(a, b) {
          return b.score - a.score || a.index - b.index;
        });
      return {
        ...group,
        items: scored.map(function toItem(entry) {
          return entry.item;
        }),
      };
    })
    .filter(function hasItems(group) {
      return group.items.length > 0;
    });
}

export function CommandPalette({
  projectId,
  projectName,
  environmentId,
  onAddService,
  onCreateEnvironment,
}: CommandPaletteProps) {
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const hasProject = Boolean(projectId);
  const envId = environmentId ?? "";

  // These share query keys with the sidebars, so they're usually cached.
  const { data: projects = [] } = useProjects();
  const { data: environment } = useQuery({
    ...orpc.environments.get.queryOptions({ input: { envId } }),
    enabled: open && hasProject && envId.length > 0,
  });
  const { data: databases = [] } = useDatabases(open ? (projectId ?? "") : "");
  const { data: objectStorages = [] } = useObjectStorages(
    open ? (projectId ?? "") : "",
  );

  const groups = useMemo(
    function buildGroups(): CommandGroup[] {
      const result: CommandGroup[] = [];

      if (hasProject && envId) {
        const base = `/projects/${projectId}/environments/${envId}`;
        const resources: CommandItem[] = [];
        for (const service of environment?.services ?? []) {
          resources.push({
            id: `service:${service.id}`,
            label: service.name,
            hint: "Service",
            keywords: ["service", "app"],
            icon: Box,
            href: `${base}/services/${service.id}`,
          });
        }
        for (const database of databases) {
          resources.push({
            id: `database:${database.id}`,
            label: database.name,
            hint: database.engine === "postgres" ? "PostgreSQL" : "MySQL",
            keywords: ["database", "db", database.engine],
            icon: Database,
            href: `${base}/databases/${database.id}`,
          });
        }
        for (const storage of objectStorages) {
          if (storage.environmentId !== envId) {
            continue;
          }
          resources.push({
            id: `storage:${storage.id}`,
            label: storage.name,
            hint: "Object storage",
            keywords: ["bucket", "s3", "storage"],
            icon: Archive,
            href: `${base}/object-storages/${storage.id}`,
          });
        }
        if (resources.length > 0) {
          result.push({
            id: "resources",
            heading: projectName ? `Resources in ${projectName}` : "Resources",
            items: resources,
          });
        }
      }

      const projectItems = projects.map(function toItem(project): CommandItem {
        return {
          id: `project:${project.id}`,
          label: project.name,
          hint: project.id === projectId ? "Current project" : undefined,
          keywords: ["project"],
          icon: FolderGit2,
          href: `/projects/${project.id}`,
        };
      });
      if (projectItems.length > 0) {
        result.push({
          id: "projects",
          heading: "Projects",
          items: projectItems,
        });
      }

      const actions: CommandItem[] = [];
      if (hasProject && onAddService) {
        actions.push({
          id: "action:add-service",
          label: "Add service",
          hint: projectName ?? undefined,
          keywords: [
            "create",
            "new",
            "deploy",
            "database",
            "storage",
            "resource",
          ],
          icon: Plus,
          perform: onAddService,
        });
      }
      actions.push({
        id: "action:new-project",
        label: "New project",
        keywords: ["create", "add", "template"],
        icon: Plus,
        href: "/projects/new",
      });
      if (hasProject && onCreateEnvironment) {
        actions.push({
          id: "action:new-environment",
          label: "New environment",
          hint: projectName ?? undefined,
          keywords: ["create", "add", "preview", "staging", "branch"],
          icon: Layers,
          perform: onCreateEnvironment,
        });
      }
      result.push({ id: "actions", heading: "Actions", items: actions });

      const navigation: CommandItem[] = [
        {
          id: "nav:home",
          label: "Home",
          hint: "All projects",
          keywords: ["projects", "dashboard", "overview"],
          icon: Home,
          href: "/",
        },
      ];
      if (hasProject) {
        navigation.push(
          {
            id: "nav:project-settings",
            label: "Project settings",
            hint: projectName ?? undefined,
            keywords: ["general", "rename", "configure"],
            icon: SlidersHorizontal,
            href: `/projects/${projectId}/settings`,
          },
          {
            id: "nav:project-environments",
            label: "Environments",
            hint: projectName ?? undefined,
            keywords: ["settings", "preview", "production"],
            icon: Layers,
            href: `/projects/${projectId}/settings/environments`,
          },
          {
            id: "nav:project-variables",
            label: "Shared variables",
            hint: projectName ?? undefined,
            keywords: ["settings", "env", "environment", "secrets"],
            icon: Variable,
            href: `/projects/${projectId}/settings/variables`,
          },
        );
      }
      for (const page of SETTINGS_PAGES) {
        navigation.push({
          id: `nav:settings:${page.id}`,
          label: page.id === "general" ? "Settings" : page.label,
          hint: page.id === "general" ? "General" : "Settings",
          keywords: page.keywords,
          icon: page.icon,
          href: page.href,
        });
      }
      result.push({
        id: "navigation",
        heading: "Navigation",
        items: navigation,
      });

      return result;
    },
    [
      hasProject,
      envId,
      projectId,
      projectName,
      environment?.services,
      databases,
      objectStorages,
      projects,
      onAddService,
      onCreateEnvironment,
    ],
  );

  const visibleGroups = useMemo(
    function getVisibleGroups() {
      return filterGroups(groups, query);
    },
    [groups, query],
  );

  const flatItems = useMemo(
    function getFlatItems() {
      return visibleGroups.flatMap(function getItems(group) {
        return group.items;
      });
    },
    [visibleGroups],
  );

  const activeItem = flatItems[activeIndex] ?? null;
  function optionId(item: CommandItem): string {
    return getOptionId(baseId, item);
  }

  // Reset selection whenever the query changes or the palette reopens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query/open change only
  useEffect(
    function resetActiveIndex() {
      setActiveIndex(0);
    },
    [query, open],
  );

  useEffect(
    function clearQueryOnClose() {
      if (!open) {
        setQuery("");
      }
    },
    [open],
  );

  useEffect(
    function scrollActiveIntoView() {
      if (!activeItem || !listRef.current) {
        return;
      }
      const element = document.getElementById(getOptionId(baseId, activeItem));
      element?.scrollIntoView({ block: "nearest" });
    },
    [activeItem, baseId],
  );

  function runItem(item: CommandItem) {
    setOpen(false);
    if (item.perform) {
      // Let the palette close (and return focus) before opening another dialog.
      const perform = item.perform;
      window.setTimeout(perform, 0);
      return;
    }
    if (item.href) {
      router.push(item.href);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (flatItems.length === 0) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex(function next(index) {
          return (index + 1) % flatItems.length;
        });
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex(function previous(index) {
          return (index - 1 + flatItems.length) % flatItems.length;
        });
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(flatItems.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (activeItem) {
          runItem(activeItem);
        }
        break;
    }
  }

  let flatIndex = -1;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/60"
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-neutral-800 px-4">
            <Search
              className="h-4 w-4 shrink-0 text-neutral-500"
              aria-hidden="true"
            />
            <input
              type="text"
              role="combobox"
              aria-label="Search projects, resources, pages and actions"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeItem ? optionId(activeItem) : undefined
              }
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={
                hasProject
                  ? "Search resources, projects, pages…"
                  : "Search projects, pages, actions…"
              }
              value={query}
              onChange={function onQueryChange(event) {
                setQuery(event.target.value);
              }}
              onKeyDown={handleKeyDown}
              className="h-12 w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
            />
            <kbd className="hidden shrink-0 rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 font-sans text-[10px] font-medium text-neutral-500 sm:inline-block">
              Esc
            </kbd>
          </div>

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
          >
            {visibleGroups.length === 0 && (
              <p className="px-3 py-10 text-center text-sm text-neutral-500">
                No results for “{query.trim()}”
              </p>
            )}
            {visibleGroups.map(function renderGroup(group) {
              const headingId = `${baseId}-group-${group.id}`;
              return (
                // biome-ignore lint/a11y/useSemanticElements: listbox option group, not a form fieldset
                <div
                  key={group.id}
                  role="group"
                  aria-labelledby={headingId}
                  className="pb-1 [&+&]:mt-1 [&+&]:border-t [&+&]:border-neutral-900 [&+&]:pt-2"
                >
                  <div
                    id={headingId}
                    role="presentation"
                    className="truncate px-2 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500"
                  >
                    {group.heading}
                  </div>
                  {group.items.map(function renderItem(item) {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isActive = index === activeIndex;
                    const Icon = item.icon;
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input via aria-activedescendant
                      <div
                        key={item.id}
                        id={optionId(item)}
                        role="option"
                        aria-selected={isActive}
                        tabIndex={-1}
                        onMouseMove={function activateOnHover() {
                          if (!isActive) {
                            setActiveIndex(index);
                          }
                        }}
                        onMouseDown={function keepInputFocus(event) {
                          event.preventDefault();
                        }}
                        onClick={function selectItem() {
                          runItem(item);
                        }}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm text-neutral-300 select-none",
                          isActive && "bg-neutral-800/80 text-neutral-100",
                        )}
                      >
                        <Icon
                          aria-hidden="true"
                          className={cn(
                            "h-4 w-4 shrink-0",
                            isActive ? "text-neutral-200" : "text-neutral-500",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {item.hint && (
                          <span className="max-w-[40%] shrink-0 truncate text-xs text-neutral-500">
                            {item.hint}
                          </span>
                        )}
                        <CornerDownLeft
                          aria-hidden="true"
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 text-neutral-500",
                            !isActive && "invisible",
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-4 border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-500">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              to navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>
              to open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Esc</Kbd>
              to close
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-neutral-800 bg-neutral-900 px-1 font-sans text-[10px] text-neutral-400">
      {children}
    </kbd>
  );
}
