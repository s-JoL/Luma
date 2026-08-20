/**
 * Direct access to generation, without going through the agent loop.
 *
 * Two sources feed one list: generation models, whose forms come from their
 * adapter's schema, and third-party MCP tools, whose forms come from their own
 * JSON Schema. From the user's side "make a picture" is one action regardless of
 * what implements it.
 *
 * `POST /studio/run` stays synchronous — it queues a job and waits — because a
 * client that only wants one picture should not have to learn the queue. The
 * `/jobs` routes are for clients that do.
 */
import { Hono } from "hono";
import type { GenerationOp, ModelSpec, StudioTool } from "@shared/types.ts";
import { registerGeneratedImage } from "../../images.ts";
import { isRunnable, opsOf, schemaOf } from "../../generation/index.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";

const GALLERY_PAGE = 60;
const MODEL_PREFIX = "model:";

const kindFor = (op: GenerationOp): StudioTool["kind"] =>
  op === "image_to_image" ? "edit" : op === "text_to_image" ? "generate" : "video";

/**
 * Loopback or a private network: our own machine, or one on the same desk. The
 * distinction is worth surfacing because it is the difference between a wait that
 * is slow and free and one that is quick and billed, and a client cannot work it
 * out from a model's name.
 */
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function isLocal(baseUrl: string | undefined) {
  if (!baseUrl) return false;
  try {
    return PRIVATE_HOST.test(new URL(baseUrl).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** One entry per operation, so "draw" and "edit" are separate choices. */
function modelTools(specs: ModelSpec[], hostOf: (providerId: string) => string | undefined): StudioTool[] {
  const items: StudioTool[] = [];
  for (const spec of specs) {
    for (const op of opsOf(spec)) {
      items.push({
        serverId: `${MODEL_PREFIX}${spec.id}`,
        serverTitle: spec.name,
        name: op,
        description: spec.systemPrompt ?? `${spec.name} · ${spec.providerId}`,
        kind: kindFor(op),
        schema: schemaOf(spec, op),
        modelId: spec.id,
        op,
        local: isLocal(hostOf(spec.providerId)),
      });
    }
  }
  return items;
}

export function studioRoutes(services: Services) {
  const app = new Hono();
  const { store, config, mcp, jobs } = services;

  const generationSpecs = () => store.listModels().filter((spec) => spec.enabled && isRunnable(spec));

  const visibleTools = (): StudioTool[] => {
    const studio = config.capabilities().studio;
    if (!studio.enabled) return [];
    const allowed = new Set(studio.servers);
    const fromMcp = mcp
      .catalogue()
      .filter((tool) => (allowed.size ? allowed.has(tool.serverId) : true))
      .filter((tool) => tool.kind !== "other");
    return [...modelTools(generationSpecs(), (providerId) => store.getProvider(providerId)?.baseUrl), ...fromMcp];
  };

  app.get("/studio/tools", (context) =>
    context.json({ items: visibleTools(), enabled: config.capabilities().studio.enabled }),
  );

  app.get("/studio/gallery", (context) => {
    const limit = Math.min(200, Math.max(1, Number(context.req.query("limit") ?? GALLERY_PAGE)));
    const offset = Math.max(0, Number(context.req.query("offset") ?? 0));
    return context.json({
      items: store.listGallery(limit, offset),
      total: store.countGallery(),
      offset,
      limit,
    });
  });

  app.post("/studio/run", async (context) => {
    const body = await readJson<{ serverId: string; tool: string; args: Record<string, unknown> }>(context);
    const tool = visibleTools().find((item) => item.serverId === body.serverId && item.name === body.tool);
    if (!tool) return fail(context, 404, "not_found", "This tool is not available");

    const started = Date.now();
    try {
      if (tool.modelId && tool.op) {
        const job = await jobs.run({ modelId: tool.modelId, op: tool.op, params: body.args ?? {} });
        if (job.status !== "succeeded") {
          return fail(context, 502, "tool_failed", job.error ?? "The job did not finish");
        }
        const asset = job.assets[0];
        if (!asset) return fail(context, 502, "tool_failed", "The job produced nothing");
        return context.json({
          jobId: job.id,
          ...(asset.kind === "video" ? { videoId: asset.assetId } : { imageId: asset.assetId }),
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs ?? null,
          provider: tool.serverTitle,
          model: job.modelName,
          elapsedMs: Date.now() - started,
        });
      }

      const response = await mcp.call(tool.serverId, tool.name, body.args ?? {});
      const structured = response.structuredContent as Record<string, unknown> | undefined;
      registerGeneratedImage(store, structured);
      const text = ((response.content ?? []) as Array<Record<string, unknown>>)
        .filter((part) => part.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n");
      const imageId = typeof structured?.image_id === "string" ? structured.image_id.toLowerCase() : "";
      if (!imageId) return fail(context, 502, "tool_failed", text.slice(0, 400) || "The tool returned no image");
      return context.json({
        imageId,
        mime: String(structured?.mime_type ?? "image/png"),
        width: structured?.width == null ? null : Number(structured.width),
        height: structured?.height == null ? null : Number(structured.height),
        provider: (structured?.provider as string | null) ?? tool.serverId,
        model: (structured?.model as string | null) ?? null,
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      return failFromError(context, error);
    }
  });

  return app;
}
