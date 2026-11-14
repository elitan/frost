import psl from "psl";

export function extractSubdomain(domain: string): string {
  const root = psl.get(domain);
  if (!root || root === domain) return "@";
  return domain.slice(0, -(root.length + 1));
}
