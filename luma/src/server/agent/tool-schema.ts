/**
 * Providers that speak Gemini's function-calling protobuf (CometAPI included)
 * reject any `enum` value that is not a string. A video duration of `[4, 8]` is
 * the usual casualty: the studio still wants integers, the model has to see
 * `"4"`. Walking the JSON rather than each adapter keeps MCP tools honest too.
 */
export function stringifyToolEnums<T>(value: T): T {
  return walk(JSON.parse(JSON.stringify(value))) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    next[key] = walk(child);
  }
  if (Array.isArray(next.enum) && next.enum.some((item) => typeof item !== "string")) {
    next.enum = next.enum.map((item) => String(item));
    if (next.type === "integer" || next.type === "number") next.type = "string";
    if (typeof next.default === "number") next.default = String(next.default);
  }
  return next;
}
