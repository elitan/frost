"use client";

import {
  AlertTriangle,
  LayoutGrid,
  List,
  Plus,
  Rocket,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import {
  ProjectGridSkeleton,
  ProjectListSkeleton,
} from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProjects } from "@/hooks/use-projects";
import type { ProjectListItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ProjectAvatar } from "./_components/project-avatar";
import { ProjectCard } from "./_components/project-card";
import { ProjectResourceBadges } from "./_components/project-resource-badges";

type ProjectViewMode = "cards" | "list";

interface ProjectListRowProps {
  project: ProjectListItem;
}

function ProjectListRow({ project }: ProjectListRowProps) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="flex items-center justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 transition-colors hover:border-neutral-700 hover:bg-neutral-800/50"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ProjectAvatar name={project.name} size="sm" />
        <div className="min-w-0">
          <p className="truncate font-medium text-neutral-100">
            {project.name}
          </p>
          {project.runningUrl && (
            <p className="truncate text-sm text-neutral-500">
              {project.runningUrl}
            </p>
          )}
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-4 text-sm text-neutral-400 md:flex">
        <ProjectResourceBadges resourceSummary={project.resourceSummary} />
      </div>
    </Link>
  );
}

function NoProjectsState() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-dashed border-neutral-800 bg-neutral-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(163,163,163,0.12),transparent_60%)]" />
      <div className="relative mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900">
          <Rocket className="h-5 w-5 text-neutral-300" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">
          Deploy your first project
        </h2>
        <p className="mt-2 text-sm text-neutral-400">
          A project groups the services, databases and storage for one app.
          Start from a GitHub repo, a Docker image or a template.
        </p>
        <Button asChild className="mt-6">
          <Link href="/projects/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Project
          </Link>
        </Button>
      </div>
    </div>
  );
}

export default function Home() {
  const { data: projects, isLoading, isError, refetch } = useProjects();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ProjectViewMode>("cards");

  const filteredProjects = useMemo(
    function getFilteredProjects() {
      if (!projects) {
        return [];
      }
      if (!search) {
        return projects;
      }
      const lower = search.toLowerCase();
      return projects.filter(function matchesSearch(project) {
        return project.name.toLowerCase().includes(lower);
      });
    },
    [projects, search],
  );

  function renderContent() {
    if (isLoading) {
      return viewMode === "cards" ? (
        <ProjectGridSkeleton />
      ) : (
        <ProjectListSkeleton />
      );
    }

    if (isError && !projects) {
      return (
        <EmptyState
          icon={AlertTriangle}
          title="Failed to load projects"
          description="Something went wrong while loading your projects"
          action={
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      );
    }

    if (!projects || projects.length === 0) {
      return <NoProjectsState />;
    }

    if (filteredProjects.length === 0) {
      return (
        <EmptyState
          icon={Search}
          title="No matching projects"
          description="Try a different search term"
        />
      );
    }

    if (viewMode === "cards") {
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map(function renderProject(project) {
            return (
              <ProjectCard
                key={project.id}
                id={project.id}
                name={project.name}
                runningUrl={project.runningUrl}
                repoUrl={project.repoUrl}
                latestDeployment={project.latestDeployment}
                resourceSummary={project.resourceSummary}
              />
            );
          })}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {filteredProjects.map(function renderProject(project) {
          return <ProjectListRow key={project.id} project={project} />;
        })}
      </div>
    );
  }

  // With no projects, the empty state carries the only CTA.
  const showToolbar = isLoading || (projects?.length ?? 0) > 0;

  return (
    <section className="space-y-6">
      {showToolbar && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <Input
              placeholder="Search projects"
              aria-label="Search projects"
              value={search}
              onChange={function onSearchChange(event) {
                setSearch(event.target.value);
              }}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <div
              aria-label="View"
              role="toolbar"
              className="inline-flex items-center rounded-md border border-neutral-800 bg-neutral-900 p-1"
            >
              <button
                type="button"
                onClick={function showCards() {
                  setViewMode("cards");
                }}
                aria-pressed={viewMode === "cards"}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400",
                  viewMode === "cards"
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-100",
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Cards
              </button>
              <button
                type="button"
                onClick={function showList() {
                  setViewMode("list");
                }}
                aria-pressed={viewMode === "list"}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400",
                  viewMode === "list"
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-100",
                )}
              >
                <List className="h-3.5 w-3.5" />
                List
              </button>
            </div>

            <Button size="sm" asChild>
              <Link href="/projects/new">
                <Plus className="mr-1 h-3.5 w-3.5" />
                New Project
              </Link>
            </Button>
          </div>
        </div>
      )}
      {renderContent()}
    </section>
  );
}
