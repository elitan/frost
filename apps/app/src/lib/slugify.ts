export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(-6);
}

export function slugifyWithFallback(name: string, prefix: string): string {
  const slug = slugify(name);
  if (slug.length > 0) return slug;
  return `${prefix}-${shortHash(name)}`;
}
