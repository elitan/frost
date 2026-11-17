import { StatusBadge } from "@/components/status-badge";
import type { ProjectListItem } from "@/lib/api";
import {
  formatProjectResourceBreakdown,
  getProjectResourceSummaryTone,
} from "@/lib/project-resource-summary";

interface ProjectResourceBadgesProps {
  resourceSummary: ProjectListItem["resourceSummary"];
  breakdownClassName?: string;
}

export function ProjectResourceBadges({
  resourceSummary,
  breakdownClassName,
}: ProjectResourceBadgesProps) {
  if (resourceSummary.totalCount === 0) {
    return null;
  }

  return (
    <>
      <span className={breakdownClassName}>
        {formatProjectResourceBreakdown(resourceSummary)}
      </span>
      <StatusBadge tone={getProjectResourceSummaryTone(resourceSummary)}>
        {resourceSummary.onlineCount}/{resourceSummary.totalCount} online
      </StatusBadge>
      {resourceSummary.sleepingCount > 0 && (
        <StatusBadge className="border-violet-800 bg-violet-900/30 text-violet-300">
          {resourceSummary.sleepingCount} sleeping
        </StatusBadge>
      )}
      {resourceSummary.attentionCount > 0 && (
        <StatusBadge tone="warning">
          {resourceSummary.attentionCount} attention
        </StatusBadge>
      )}
    </>
  );
}
