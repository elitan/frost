import { SkeletonBlock, SkeletonStatus } from "./skeleton-block";

function SidebarSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2 border-b border-neutral-800 px-4 py-3">
      {children}
    </div>
  );
}

/**
 * Placeholder for the project left menu while project data loads. Keeps the
 * same width, header height and section rhythm so nothing shifts on load.
 */
export function ProjectSidebarSkeleton({
  header,
}: {
  header?: React.ReactNode;
}) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40">
      {header}
      <SkeletonStatus label="Loading project" className="flex flex-1 flex-col">
        <SidebarSection>
          <SkeletonBlock className="h-3 w-14" />
          <SkeletonBlock className="h-5 w-32" />
        </SidebarSection>
        <SidebarSection>
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-5 w-24" />
        </SidebarSection>
        <div className="space-y-3 px-4 py-3">
          <SkeletonBlock className="h-3 w-16" />
          {[0, 1, 2].map(function renderItem(index) {
            return (
              <div key={index} className="flex items-center gap-2.5">
                <SkeletonBlock className="h-7 w-7 shrink-0 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <SkeletonBlock className="h-3.5 w-24" />
                  <SkeletonBlock className="h-3 w-32" />
                </div>
              </div>
            );
          })}
        </div>
      </SkeletonStatus>
    </aside>
  );
}
