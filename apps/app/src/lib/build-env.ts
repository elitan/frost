export interface BuildEnvVar {
  key: string;
  value: string;
  buildTime?: boolean;
}

// Frameworks inline these into client bundles at build time, so they are
// always passed to `docker build` for backwards compatibility.
export const PUBLIC_BUILD_ENV_PREFIXES = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
] as const;

export function hasPublicBuildEnvPrefix(key: string): boolean {
  return PUBLIC_BUILD_ENV_PREFIXES.some(function matchesPrefix(prefix) {
    return key.startsWith(prefix);
  });
}

export function isBuildTimeEnvVar(envVar: BuildEnvVar): boolean {
  return envVar.buildTime === true || hasPublicBuildEnvPrefix(envVar.key);
}

// Later lists override earlier ones by key (the whole entry, including the
// buildTime flag), keeping the position of the first occurrence.
export function mergeEnvVarLists<T extends BuildEnvVar>(...lists: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const list of lists) {
    for (const envVar of list) {
      merged.set(envVar.key, envVar);
    }
  }
  return [...merged.values()];
}

export function selectBuildTimeEnvVars<T extends BuildEnvVar>(
  envVars: T[],
): T[] {
  return envVars.filter(isBuildTimeEnvVar);
}

export function envVarListToRecord(
  envVars: BuildEnvVar[],
): Record<string, string> {
  return Object.fromEntries(
    envVars.map(function toEntry(envVar) {
      return [envVar.key, envVar.value];
    }),
  );
}
