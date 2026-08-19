import { isMemoryKey } from "@shared/types.ts";
import { Hono } from "hono";
import { countTokens } from "../../prompts/context.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail } from "../errors.ts";

export function memoryRoutes(services: Services) {
  const app = new Hono();
  const { store, config } = services;

  const snapshot = () => {
    const items = store.listMemories();
    const capability = config.capabilities().memory;
    return {
      items,
      tokens: items.reduce((total, item) => total + item.tokens, 0),
      limit: capability.tokenLimit,
      charLimit: capability.charLimit,
      suggestedKeys: capability.suggestedKeys,
    };
  };

  app.get("/memory", (context) => context.json(snapshot()));

  app.put("/memory/:key", async (context) => {
    const key = context.req.param("key");
    const capability = config.capabilities().memory;
    if (!isMemoryKey(key)) {
      return fail(context, 400, "invalid_key", "Key must be 1-64 characters of letters, digits, _ or -");
    }
    const body = await readJson<{ value: string }>(context);
    const value = (body.value ?? "").trim();
    if (!value) return fail(context, 400, "invalid", "value is required");
    if (value.length > capability.charLimit) {
      return fail(context, 400, "too_long", `Value exceeds ${capability.charLimit} characters`);
    }
    const tokens = countTokens(value);
    const others = store.listMemories().filter((item) => item.key !== key);
    const total = others.reduce((sum, item) => sum + item.tokens, 0) + tokens;
    if (total > capability.tokenLimit) {
      return fail(context, 400, "over_budget", "Memory storage would exceed the configured token limit");
    }
    store.upsertMemory(key, value, tokens);
    return context.json(snapshot());
  });

  app.delete("/memory/:key", (context) => {
    store.deleteMemory(context.req.param("key"));
    return context.json(snapshot());
  });

  return app;
}
