import { GitCommit, Package } from "lucide-react";
import { cn } from "@/lib/utils";

const HEX_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export function isHexSha(value: string): boolean {
  return HEX_SHA_PATTERN.test(value);
}

export interface DeploymentRefInfo {
  kind: "commit" | "image";
  label: string;
  full: string;
}

/**
 * Deployments store the git commit SHA in `commitSha`, but image deploys put
 * the image tag there (e.g. "6.7-apache"). Only real hex SHAs are shortened.
 */
export function getDeploymentRef(
  value: string | null | undefined,
  deployType?: string | null,
): DeploymentRefInfo | null {
  if (!value) return null;
  if (deployType === "image" || !isHexSha(value)) {
    return { kind: "image", label: value, full: value };
  }
  return { kind: "commit", label: value.slice(0, 7), full: value };
}

interface DeploymentRefProps {
  value: string | null | undefined;
  deployType?: string | null;
  fallback?: string;
  showIcon?: boolean;
  className?: string;
}

export function DeploymentRef({
  value,
  deployType,
  fallback,
  showIcon = true,
  className,
}: DeploymentRefProps) {
  const ref = getDeploymentRef(value, deployType);
  if (!ref) {
    return fallback ? (
      <span className={cn("font-mono", className)}>{fallback}</span>
    ) : null;
  }
  const Icon = ref.kind === "image" ? Package : GitCommit;
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      title={ref.kind === "image" ? `Image tag ${ref.full}` : ref.full}
    >
      {showIcon && (
        <Icon
          className="h-3 w-3 shrink-0"
          aria-label={ref.kind === "image" ? "Image tag" : "Commit"}
        />
      )}
      <span className="truncate font-mono">{ref.label}</span>
    </span>
  );
}
