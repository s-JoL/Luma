import type { Context } from "hono";

/** Reads a JSON body, treating a malformed or absent one as empty. */
export async function readJson<T>(context: Context): Promise<Partial<T>> {
  try {
    const value = await context.req.json();
    return value && typeof value === "object" ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}
