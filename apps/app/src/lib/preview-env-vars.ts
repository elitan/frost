import { envVarListToRecord, mergeEnvVarLists } from "./build-env";

export interface EnvVarEntry {
  key: string;
  value: string;
  buildTime?: boolean;
}

// System-managed service vars that must survive cloning into a preview,
// otherwise the cloned container would listen on the wrong port.
export const PRESERVED_SERVICE_ENV_KEYS: readonly string[] = ["PORT"];

export function parseEnvVarList(
  json: string | null | undefined,
): EnvVarEntry[] {
  if (!json) return [];
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? (parsed as EnvVarEntry[]) : [];
}

export function selectClonedServiceEnvVars(
  sourceEnvVars: EnvVarEntry[],
  inheritProduction: boolean,
): EnvVarEntry[] {
  if (inheritProduction) return sourceEnvVars;
  return sourceEnvVars.filter((e) =>
    PRESERVED_SERVICE_ENV_KEYS.includes(e.key),
  );
}

export interface ResolveDeploymentEnvVarsInput {
  environmentType: string | null | undefined;
  projectEnvVars: EnvVarEntry[];
  previewEnvVars: EnvVarEntry[];
  previewInheritEnvVars: boolean | number | null | undefined;
  serviceEnvVars: EnvVarEntry[];
}

// Precedence (lowest to highest):
//   non-preview: project vars < service vars
//   preview + inherit: project vars < preview vars < service vars
//   preview (default): preview vars < service vars
// Returns full entries so per-variable flags (e.g. buildTime) survive.
export function resolveDeploymentEnvVarList(
  input: ResolveDeploymentEnvVarsInput,
): EnvVarEntry[] {
  if (input.environmentType !== "preview") {
    return mergeEnvVarLists(input.projectEnvVars, input.serviceEnvVars);
  }
  if (input.previewInheritEnvVars) {
    return mergeEnvVarLists(
      input.projectEnvVars,
      input.previewEnvVars,
      input.serviceEnvVars,
    );
  }
  return mergeEnvVarLists(input.previewEnvVars, input.serviceEnvVars);
}

export function resolveDeploymentEnvVars(
  input: ResolveDeploymentEnvVarsInput,
): Record<string, string> {
  return envVarListToRecord(resolveDeploymentEnvVarList(input));
}
