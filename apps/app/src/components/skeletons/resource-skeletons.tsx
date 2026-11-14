import { SkeletonBlock, SkeletonStatus } from "./skeleton-block";

const NAME_WIDTHS = ["w-24", "w-32", "w-20", "w-28"];

/** Mirrors `ServiceCard` / `ServiceContent` (icon, name, url, badge, meta). */
export function ResourceCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-3 flex items-start gap-3">
        <SkeletonBlock className="h-9 w-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <div className="flex items-center justify-between">
            <SkeletonBlock
              className={`h-4 ${NAME_WIDTHS[index % NAME_WIDTHS.length]}`}
            />
            <SkeletonBlock className="h-2 w-2 rounded-full" />
          </div>
          <SkeletonBlock className="h-3 w-28" />
        </div>
      </div>
      <SkeletonBlock className="mb-2 h-5 w-32 rounded-full" />
      <SkeletonBlock className="h-3 w-16" />
    </div>
  );
}

/** Mirrors `EnvironmentResourceSections`: a labelled section of cards. */
export function ResourceGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonStatus label="Loading resources" className="space-y-6">
      <section className="space-y-3">
        <SkeletonBlock className="h-3 w-16" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: count }, function renderCard(_, index) {
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
            return <ResourceCardSkeleton key={index} index={index} />;
          })}
        </div>
      </section>
    </SkeletonStatus>
  );
}
