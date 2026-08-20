/**
 * Direct access to generation, without going through the agent loop.
 *
 * The catalogue is generation models only. MCP is for the agent, not a second
 * way to draw. `POST /studio/run` is `POST /jobs` that waits: same body, the
 * finished job row back, so a client that wants one picture does not have to
 * learn the queue.
 */
import { Hono } from "hono";
import type { GenerationOp, JobInput, ModelSpec, StudioTool } from "@shared/types.ts";
import { resolveProfile } from "../../agent/profile.ts";
import { isRunnable, opsOf, schemaOf, studioPriority } from "../../generation/index.ts";
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
        configured: spec.configured !== false,
      });
    }
  }
  return items;
}

const KIND_RANK: Record<StudioTool["kind"], number> = { generate: 0, edit: 1, video: 2 };

export function studioRoutes(services: Services) {
  const app = new Hono();
  const { store, config, jobs } = services;

  const visibleTools = (): StudioTool[] => {
    if (!config.capabilities().studio.enabled) return [];
    const specs = store.listModels().filter((spec) => spec.enabled && isRunnable(spec));
    const byId = new Map(specs.map((spec) => [spec.id, spec]));
    const preferred = resolveProfile(store, config, {});
    const bound = (tool: StudioTool) => {
      if (tool.kind === "generate") return preferred.image?.id === tool.modelId;
      if (tool.kind === "edit") return preferred.edit?.id === tool.modelId;
      return preferred.video?.id === tool.modelId;
    };
    const rank = (id: string) => {
      const spec = byId.get(id);
      return spec ? studioPriority(spec) : 2;
    };
    return modelTools(specs, (providerId) => store.getProvider(providerId)?.baseUrl).sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        Number(bound(b)) - Number(bound(a)) ||
        rank(a.modelId) - rank(b.modelId) ||
        a.serverTitle.localeCompare(b.serverTitle, "zh"),
    );
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
    const body = await readJson<JobInput>(context);
    const modelId = body.modelId;
    if (!modelId) return fail(context, 400, "invalid", "modelId is required");
    try {
      const job = await jobs.run({ ...body, modelId });
      if (job.status !== "succeeded") {
        return fail(context, 502, "tool_failed", job.error ?? "The job did not finish");
      }
      return context.json(job);
    } catch (error) {
      return failFromError(context, error);
    }
  });

  return app;
}
