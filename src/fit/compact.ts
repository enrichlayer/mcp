function isEmpty(value: unknown): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item !== null && typeof item === "object" ? compact(item) : item));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const compacted = compact(child);
    if (!isEmpty(compacted)) out[key] = compacted;
  }
  return out;
}
