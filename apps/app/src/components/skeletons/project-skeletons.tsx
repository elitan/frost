import { SkeletonBlock, SkeletonStatus } from "./skeleton-block";

const NAME_WIDTHS = ["w-32", "w-24", "w-36", "w-28", "w-40", "w-20"];
const META_WIDTHS = ["w-44", "w-36", "w-48", "w-40", "w-32", "w-44"];

/** Mirrors the layout of `ProjectCard` (avatar, name, url, badges, deploy). */
export function ProjectCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-start gap-3">
        <SkeletonBlock className="h-10 w-10 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <SkeletonBlock
            className={`h-4 ${NAME_WIDTHS[index % NAME_WIDTHS.length]}`}
          />
          <SkeletonBlock
            className={`h-3.5 ${META_WIDTHS[index % META_WIDTHS.length]}`}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <SkeletonBlock className="h-4 w-16" />
        <SkeletonBlock className="h-5 w-16 rounded-full" />
      </div>
      <SkeletonBlock className="mt-3 h-3 w-14" />
    </div>
  );
}

export function ProjectGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <SkeletonStatus
      label="Loading projects"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }, function renderCard(_, index) {
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
        return <ProjectCardSkeleton key={index} index={index} />;
      })}
    </SkeletonStatus>
  );
}

/** Mirrors `ProjectListRow` on the home page. */
export function ProjectRowSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <SkeletonBlock className="h-8 w-8 shrink-0 rounded-full" />
        <div className="space-y-2">
          <SkeletonBlock
            className={`h-4 ${NAME_WIDTHS[index % NAME_WIDTHS.length]}`}
          />
          <SkeletonBlock
            className={`h-3 ${META_WIDTHS[index % META_WIDTHS.length]}`}
          />
        </div>
      </div>
      <div className="hidden items-center gap-2 md:flex">
        <SkeletonBlock className="h-4 w-16" />
        <SkeletonBlock className="h-5 w-16 rounded-full" />
      </div>
    </div>
  );
}

export function ProjectListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonStatus label="Loading projects" className="space-y-2">
      {Array.from({ length: count }, function renderRow(_, index) {
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
        return <ProjectRowSkeleton key={index} index={index} />;
      })}
    </SkeletonStatus>
  );
}
