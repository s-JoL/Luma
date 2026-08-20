import { Hono } from "hono";
import type {
  ApiMode,
  Capabilities,
  McpServer,
  ModelInput,
  ModelKind,
  PromptSettings,
  ProviderInput,
} from "@shared/types.ts";
import { API_MODES } from "@shared/types.ts";
import { SECRET } from "../../config.ts";
import { adapterOps } from "../../generation/index.ts";
import { slug } from "../../ids.ts";
import { discoverModels } from "../../models/catalogue.ts";
import { providerAuth } from "../../models/auth.ts";
import { DEFAULT_GLOBAL_PROMPT, DEFAULT_TOOL_PROMPT } from "../../prompts/defaults.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";

const API_MODE_IDS = API_MODES.map((mode) => mode.id);

export function settingsRoutes(services: Services) {
  const app = new Hono();
  const { store, config, vault, registry, mcp } = services;

  // --------------------------------------------------------------- providers

  app.get("/providers", (context) => context.json(store.listProviders()));

  app.post("/providers", async (context) => {
    const body = await readJson<ProviderInput>(context);
    if (!body.name || !body.baseUrl) return fail(context, 400, "invalid", "name and baseUrl are required");
    const id = slug(body.id || body.name, "provider");
    if (store.getProvider(id)) return fail(context, 409, "conflict", `Provider ${id} already exists`);
    const provider = store.upsertProvider({ ...body, id, name: body.name, baseUrl: body.baseUrl });
    if (body.apiKey) vault.set(SECRET.provider(id), body.apiKey);
    services.reload();
    return context.json(store.getProvider(provider.id), 201);
  });

  app.patch("/providers/:id", async (context) => {
    const id = context.req.param("id");
    const existing = store.getProvider(id);
    if (!existing) return fail(context, 404, "not_found", "Provider not found");
    const body = await readJson<ProviderInput>(context);
    store.upsertProvider({
      id,
      name: body.name ?? existing.name,
      baseUrl: body.baseUrl ?? existing.baseUrl,
      enabled: body.enabled ?? existing.enabled,
      // Carried as sent rather than defaulted to the stored value: the store
      // keeps the old style on `undefined` and clears it on an explicit null,
      // which is how a provider goes back to bearer.
      auth: body.auth,
    });
    if (typeof body.apiKey === "string") vault.set(SECRET.provider(id), body.apiKey);
    services.reload();
    return context.json(store.getProvider(id));
  });

  app.delete("/providers/:id", (context) => {
    store.deleteProvider(context.req.param("id"));
    services.reload();
    return context.body(null, 204);
  });

  app.put("/providers/:id/key", async (context) => {
    const id = context.req.param("id");
    if (!store.getProvider(id)) return fail(context, 404, "not_found", "Provider not found");
    const body = await readJson<{ value: string }>(context);
    vault.set(SECRET.provider(id), body.value ?? "");
    services.reload();
    return context.body(null, 204);
  });

  app.delete("/providers/:id/key", (context) => {
    vault.delete(SECRET.provider(context.req.param("id")));
    services.reload();
    return context.body(null, 204);
  });

  /** Live catalogue from the provider, so models can be added without typing ids. */
  app.get("/providers/:id/models", async (context) => {
    const provider = store.getProvider(context.req.param("id"));
    if (!provider) return fail(context, 404, "not_found", "Provider not found");
    const key = vault.get(SECRET.provider(provider.id));
    if (!key && providerAuth(provider).style !== "none") {
      return fail(context, 422, "not_configured", `${provider.name} has no API key`);
    }
    const configured = new Set(
      store.listModels().filter((spec) => spec.providerId === provider.id).map((spec) => spec.model),
    );
    try {
      const items = await discoverModels(provider, key ?? "", configured, context.req.raw.signal);
      return context.json({ items });
    } catch (error) {
      return failFromError(context, error, "upstream_error");
    }
  });

  // ------------------------------------------------------------------ models

  app.get("/models", (context) =>
    context.json({ items: store.listModels(), defaultModelId: config.defaultModelId() }),
  );

  app.post("/models", async (context) => {
    const body = await readJson<ModelInput>(context);
    if (!body.providerId || !body.model) return fail(context, 400, "invalid", "providerId and model are required");
    if (!store.getProvider(body.providerId)) return fail(context, 400, "invalid", "Unknown provider");
    const id = slug(body.id || `${body.providerId}-${body.model}`, "model");
    if (store.getModel(id)) return fail(context, 409, "conflict", `Model ${id} already exists`);
    const model = store.upsertModel(normalizeModel({ ...body, id } as ModelInput));
    services.reload();
    return context.json(model, 201);
  });

  /**
   * Adds several models from the provider's catalogue in one write. Picking a
   * dozen models one dialog at a time is the tedious part of setting this up,
   * and a single reload beats a dozen.
   */
  app.post("/models/bulk", async (context) => {
    const body = await readJson<{ providerId: string; models: ModelInput[] }>(context);
    const provider = store.getProvider(body.providerId ?? "");
    if (!provider) return fail(context, 400, "invalid", "Unknown provider");
    const added: string[] = [];
    const skipped: string[] = [];
    let order = store.listModels().length;
    for (const entry of body.models ?? []) {
      if (!entry.model) continue;
      const id = slug(entry.id || `${provider.id}-${entry.model}`, "model");
      if (store.getModel(id)) {
        skipped.push(id);
        continue;
      }
      store.upsertModel(
        normalizeModel({ ...entry, id, providerId: provider.id, sortOrder: order++ } as ModelInput),
      );
      added.push(id);
    }
    services.reload();
    return context.json({ added, skipped }, 201);
  });

  app.patch("/models/:id", async (context) => {
    const id = context.req.param("id");
    const existing = store.getModel(id);
    if (!existing) return fail(context, 404, "not_found", "Model not found");
    const body = await readJson<ModelInput>(context);
    const merged = { ...existing, ...body, id };
    store.upsertModel(normalizeModel(merged));
    services.reload();
    return context.json(store.getModel(id));
  });

  app.delete("/models/:id", (context) => {
    store.deleteModel(context.req.param("id"));
    services.reload();
    return context.body(null, 204);
  });

  app.put("/models/default", async (context) => {
    const body = await readJson<{ modelId: string }>(context);
    if (!body.modelId || !store.getModel(body.modelId)) return fail(context, 400, "invalid", "Unknown model");
    return context.json({ defaultModelId: config.setDefaultModelId(body.modelId) });
  });

  // ------------------------------------------------------------ capabilities

  app.get("/capabilities", (context) => context.json(config.capabilities()));

  app.patch("/capabilities", async (context) => {
    const body = await readJson<Capabilities>(context);
    return context.json(config.saveCapabilities(body));
  });

  app.put("/capabilities/secrets/:name", async (context) => {
    const name = context.req.param("name");
    if (name !== SECRET.tavily && name !== SECRET.embedding) {
      return fail(context, 400, "invalid", "Unknown secret");
    }
    const body = await readJson<{ value: string }>(context);
    vault.set(name, body.value ?? "");
    return context.json(config.capabilities());
  });

  app.delete("/capabilities/secrets/:name", (context) => {
    vault.delete(context.req.param("name"));
    return context.json(config.capabilities());
  });

  // ----------------------------------------------------------------- prompts

  app.get("/prompts", (context) => context.json(config.prompts()));

  // The shipped pair, so an edited prompt is not a one-way door: an install that
  // predates a change to the recommended prompt has no other way to reach it.
  app.get("/prompts/defaults", (context) =>
    context.json({ globalPrompt: DEFAULT_GLOBAL_PROMPT, toolPrompt: DEFAULT_TOOL_PROMPT }),
  );

  app.put("/prompts", async (context) => {
    const body = await readJson<PromptSettings>(context);
    return context.json(config.savePrompts(body));
  });

  // --------------------------------------------------------------------- mcp

  app.get("/mcp/servers", (context) =>
    context.json({ items: store.listMcpServers(), status: mcp.status() }),
  );

  app.post("/mcp/servers", async (context) => {
    const body = await readJson<McpServer>(context);
    // A record is stdio or remote depending on which of the two it carries, so
    // demanding a command would make a remote server unrepresentable.
    if (!body.title || (!body.command && !body.url)) {
      return fail(context, 400, "invalid", "title and one of command or url are required");
    }
    const id = slug(body.id || body.title, "mcp");
    if (store.listMcpServers().some((server) => server.id === id)) {
      return fail(context, 409, "conflict", `MCP server ${id} already exists`);
    }
    const server = store.upsertMcpServer({
      id,
      title: body.title,
      enabled: body.enabled !== false,
      command: body.command ?? "",
      url: body.url,
      args: Array.isArray(body.args) ? body.args.map(String) : [],
      env: body.env && typeof body.env === "object" ? body.env : {},
      headers: body.headers && typeof body.headers === "object" ? body.headers : undefined,
    });
    await mcp.connect();
    return context.json(server, 201);
  });

  app.patch("/mcp/servers/:id", async (context) => {
    const id = context.req.param("id");
    const existing = store.listMcpServers().find((server) => server.id === id);
    if (!existing) return fail(context, 404, "not_found", "MCP server not found");
    const body = await readJson<McpServer>(context);
    store.upsertMcpServer({
      id,
      title: body.title ?? existing.title,
      enabled: body.enabled ?? existing.enabled,
      // An empty string is how the client switches sides — it clears the half
      // that no longer applies — so only an absent field falls back.
      command: body.command ?? existing.command,
      url: body.url ?? existing.url,
      args: Array.isArray(body.args) ? body.args.map(String) : existing.args,
      env: body.env && typeof body.env === "object" ? body.env : existing.env,
      headers: body.headers && typeof body.headers === "object" ? body.headers : existing.headers,
    });
    await mcp.connect();
    return context.json({ items: store.listMcpServers(), status: mcp.status() });
  });

  app.delete("/mcp/servers/:id", async (context) => {
    store.deleteMcpServer(context.req.param("id"));
    await mcp.connect();
    return context.body(null, 204);
  });

  app.post("/mcp/reconnect", async (context) => {
    await mcp.connect();
    return context.json({ status: mcp.status() });
  });

  void registry;
  return app;
}

/**
 * A model row as the database wants it, from whatever a client sent.
 *
 * `kind` and `ops` are carried rather than defaulted, because dropping them made
 * two things impossible: adding an image model at all, and editing one without
 * turning it into a chat model — a toggle of `enabled` was enough to strip a
 * working ComfyUI binding. Ops are filtered to what the mode's adapter can
 * actually do, so a row cannot advertise an operation nothing will run
 * (`03-generation.md §Models grow a kind`).
 */
function normalizeModel(input: ModelInput): ModelInput {
  const apiMode = API_MODE_IDS.includes(input.apiMode as ApiMode) ? input.apiMode : "openai-chat";
  const kind = kindFor(input.kind, apiMode);
  const generates = kind === "image" || kind === "video";
  const ops = adapterOps(apiMode, kind, input.ops);
  return {
    id: input.id,
    providerId: input.providerId,
    name: input.name || input.model,
    model: input.model,
    kind,
    ops,
    params: input.params && typeof input.params === "object" ? input.params : null,
    enabled: input.enabled !== false,
    // Nothing that cannot hold a conversation belongs in the chat switcher, and
    // nothing that holds one is offered to the agent as a thing it can call.
    pinned: generates ? false : input.pinned !== false,
    agentTool: generates ? Boolean(input.agentTool) : false,
    reasoning: generates ? false : Boolean(input.reasoning),
    input: Array.isArray(input.input) && input.input.length ? input.input : ["text"],
    contextWindow: Math.max(1024, Number(input.contextWindow) || 128000),
    maxTokens: Math.max(256, Number(input.maxTokens) || 8192),
    thinkingLevel: generates ? "off" : (input.thinkingLevel ?? "off"),
    thinkingLevelMap: generates ? null : (input.thinkingLevelMap ?? null),
    apiMode,
    librechatCompat: Boolean(input.librechatCompat),
    systemPrompt: input.systemPrompt ?? null,
    temperature: generates ? null : (input.temperature ?? null),
    topP: generates ? null : (input.topP ?? null),
    pricing: input.pricing ?? null,
    compat: input.compat ?? null,
    sortOrder: input.sortOrder,
  };
}

/** The mode decides the kind when a client does not name one. */
function kindFor(kind: ModelKind | undefined, apiMode: ApiMode): ModelKind {
  const modes = API_MODES.find((mode) => mode.id === apiMode)?.kinds ?? ["chat"];
  if (kind && modes.includes(kind)) return kind;
  return modes[0] ?? "chat";
}
