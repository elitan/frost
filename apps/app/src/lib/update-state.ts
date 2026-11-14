export const UPDATE_SERVICE_TRIGGER_COMMAND =
  "systemctl start --no-block frost-update.service || systemctl restart frost";

// Auto-update is opt-in: only an explicit "true" enables it, so installs that
// never touched the setting stay notify-only.
export function isAutoUpdateEnabled(value: string | null | undefined): boolean {
  return value === "true";
}

export interface ParsedUpdateResult {
  completed: boolean;
  success: boolean;
  newVersion: string | null;
}

// update.sh writes "success:<version>" or "failed" (optionally "failed:<reason>").
export function parseUpdateResult(content: string): ParsedUpdateResult {
  const trimmed = content.trim();

  if (trimmed === "failed" || trimmed.startsWith("failed:")) {
    return { completed: true, success: false, newVersion: null };
  }

  if (trimmed.startsWith("success:")) {
    const newVersion = trimmed.slice("success:".length).trim();
    return { completed: true, success: true, newVersion: newVersion || null };
  }

  return { completed: false, success: false, newVersion: null };
}
