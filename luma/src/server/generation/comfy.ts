/**
 * ComfyUI as an image API that happens to listen on 127.0.0.1.
 *
 * A model is a graph in API format plus a map from logical parameters to node
 * inputs, so a new workflow is a JSON file and a database row rather than code:
 *
 *   { "workflow": "lustify-v10.json",
 *     "bind": { "prompt": "4.inputs.text", "width": "7.inputs.width",
 *               "height": "7.inputs.height", "seed": "8.inputs.seed" },
 *     "sizes": { "auto": [1152, 1536], "16:9": [1792, 1024] },
 *     "maxPixels": 1900000 }
 *
 * The graph file may declare the same thing about itself under a `luma` key,
 * together with the schema of each knob it exposes — steps, cfg, sampler,
 * scheduler, seed, denoise, a negative prompt — because which knobs exist and
 * what their author recommends is a property of the workflow, not of this file.
 * The row still wins the merge, since the row is what a user can edit.
 *
 * The submit/poll/fetch mechanics are carried over from the MCP sidecar this
 * replaces, including the parts that only exist because they were needed: a
 * client-generated prompt id so a retried submit cannot queue the work twice, and
 * a cancel on the way out so a timed-out prompt does not keep the GPU.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GenerationOp, JsonSchema, ModelSpec } from "@shared/types.ts";
import { paths } from "../env.ts";
import { saveImageBytes, saveVideoBytes } from "../images.ts";
import { backoff, request } from "./http.ts";
import {
  GenerationError,
  promptField,
  type GenerationAdapter,
  type GenerationContext,
  type GenerationRequest,
  type GenerationResult,
} from "./types.ts";

const POLL_MS = 1_000;
const TOTAL_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 4;
const DEFAULT_MAX_PIXELS = 1_900_000;

/** Sizes the Lustify workflow was tuned for; a model row can replace them. */
const DEFAULT_SIZES: Record<string, [number, number]> = {
  auto: [1152, 1536],
  "1:1": [1344, 1344],
  "3:4": [1152, 1536],
  "2:3": [1024, 1536],
  "9:16": [1024, 1792],
  "3:2": [1536, 1024],
  "16:9": [1792, 1024],
};

interface ComfyParams {
  workflow?: string;
  bind?: Record<string, string>;
  sizes?: Record<string, [number, number]>;
  maxPixels?: number;
  /** Megapixel ceiling for an edit, protecting local VRAM. */
  editMegapixels?: number;
  /** The schema of each bound knob, keyed by the same name as its binding. */
  controls?: Record<string, JsonSchema>;
}

/** Where a graph file declares what it binds; stripped before it is submitted. */
const DECLARATION = "luma";

/** Written from the request itself, so a workflow cannot expose them as knobs. */
const STRUCTURAL = new Set(["prompt", "source", "megapixels", "width", "height", "aspect_ratio", "source_image_id"]);

/** Randomised unless it is asked for, which is why it is not a plain knob. */
const SEED = "seed";

const params = (spec: ModelSpec) => (spec.params ?? {}) as ComfyParams;
const sizesIn = (config: ComfyParams) => config.sizes ?? DEFAULT_SIZES;

function graphFile(spec: ModelSpec) {
  const name = params(spec).workflow;
  if (!name) throw new GenerationError(`${spec.name} has no workflow file configured`, "not_configured");
  // Only a file inside the workflow directory: a model row is user input.
  const file = path.join(paths.workflows, path.basename(name));
  if (!fs.existsSync(file)) throw new GenerationError(`Workflow ${path.basename(name)} is missing`, "not_configured");
  return file;
}

const readWorkflow = (spec: ModelSpec) =>
  JSON.parse(fs.readFileSync(graphFile(spec), "utf8")) as Record<string, unknown>;

function loadGraph(raw: Record<string, unknown>): Record<string, { class_type?: string; inputs?: Record<string, unknown> }> {
  // Accept an editor export as well as an API export, since that is what a user
  // has on disk when they save from ComfyUI itself.
  const graph = (raw.prompt ?? raw) as Record<string, never>;
  if (!graph || typeof graph !== "object") throw new GenerationError("Workflow is not a graph", "not_configured");
  const clone: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> = structuredClone(graph);
  // ComfyUI validates every key as a node, so our own declaration never ships.
  delete clone[DECLARATION];
  return clone;
}

/**
 * What the graph says about itself, overridden by what the row says. A schema is
 * asked for on every studio listing and on every turn the agent takes, so a
 * missing or malformed file degrades to "no knobs" rather than failing a screen.
 */
function configOf(spec: ModelSpec, raw?: Record<string, unknown>): ComfyParams {
  const row = params(spec);
  let declared: ComfyParams = {};
  try {
    const source = raw ?? readWorkflow(spec);
    const block = source[DECLARATION];
    if (block && typeof block === "object") declared = block as ComfyParams;
  } catch {
    declared = {};
  }
  return {
    ...declared,
    ...row,
    bind: { ...declared.bind, ...row.bind },
    controls: { ...declared.controls, ...row.controls },
  };
}

/** A form posts strings; a node input is typed, and a knob has its own limits. */
function knobValue(value: unknown, control: JsonSchema) {
  if (value == null || value === "") return undefined;
  if (control.type === "number" || control.type === "integer") {
    const asked = Number(value);
    if (!Number.isFinite(asked)) return undefined;
    const floor = control.minimum ?? asked;
    const ceiling = control.maximum ?? asked;
    const clamped = Math.min(ceiling, Math.max(floor, asked));
    return control.type === "integer" ? Math.round(clamped) : clamped;
  }
  if (control.type === "boolean") return value === true || value === "true";
  return String(value);
}

/**
 * A seed of -1 — the convention every sampler UI uses — is what asks for a
 * different picture, and a random one per call is what makes "draw it again"
 * mean something. Naming one is how a picture is reproduced.
 */
function seedFor(request: GenerationRequest) {
  const asked = Number(request.params[SEED] ?? -1);
  if (Number.isFinite(asked) && asked >= 0) return Math.floor(asked);
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/** Writes `4.inputs.text` style paths, which is the whole binding mechanism. */
function bind(graph: Record<string, unknown>, target: string | undefined, value: unknown) {
  if (!target) return false;
  const segments = target.split(".");
  let cursor: Record<string, unknown> = graph;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== "object") return false;
    cursor = next as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
  return true;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GenerationError("Cancelled", "cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Every call to the backend, on the one retry policy the hosted adapters use.
 * Unlike them, a status is never handed back for inspection: ComfyUI's HTTP API
 * answers 200 or nothing useful, so a bad status is the error.
 */
async function comfy(base: string, route: string, init: RequestInit & { attempts?: number } = {}) {
  const { signal, ...rest } = init;
  const response = await request(`${base}${route}`, {
    ...rest,
    cancel: signal ?? undefined,
    label: `ComfyUI ${route}`,
  });
  if (!response.ok) {
    throw new GenerationError(`ComfyUI ${route} returned ${response.status}${await rejection(response)}`, "upstream_error");
  }
  return response;
}

/**
 * A rejected graph comes back naming the node and the input ComfyUI objected
 * to. Dropping it leaves every binding mistake looking like a dead backend,
 * which is an afternoon of guessing over a sentence the backend already sent.
 */
async function rejection(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return "";
  let payload: PromptRejection;
  try {
    payload = JSON.parse(text) as PromptRejection;
  } catch {
    return `: ${clip(text)}`;
  }
  const lines: string[] = [];
  const headline = [payload.error?.message, payload.error?.details].filter(Boolean).join(" — ");
  if (headline) lines.push(headline);
  for (const [id, node] of Object.entries(payload.node_errors ?? {})) {
    const detail = (node.errors ?? [])
      .map((entry) => [entry.message, entry.details].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ");
    lines.push(`node ${id}${node.class_type ? ` (${node.class_type})` : ""}${detail ? ` ${detail}` : ""}`);
  }
  return lines.length ? `: ${clip(lines.join(" | "))}` : "";
}

interface PromptRejection {
  error?: { message?: string; details?: string };
  node_errors?: Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }>;
}

const clip = (text: string) => (text.length > 400 ? `${text.slice(0, 400)}…` : text).replace(/\s+/g, " ").trim();

/** ComfyUI Desktop's jobs API, used only to answer "did my submit land?". */
async function promptExists(base: string, promptId: string) {
  try {
    const response = await fetch(`${base}/api/jobs/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return true;
    if (response.status === 404) return false;
  } catch {
    return null;
  }
  return null;
}

async function cancelPrompt(base: string, promptId: string) {
  try {
    await fetch(`${base}/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // A cleanup that fails must not mask the error that caused it.
  }
}

async function queueUp(base: string, graph: unknown, promptId: string, signal: AbortSignal) {
  const body = JSON.stringify({ prompt_id: promptId, prompt: graph });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await comfy(base, "/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        attempts: 1,
        signal,
      });
      const result = (await response.json()) as { prompt_id?: string };
      return result.prompt_id ?? promptId;
    } catch (error) {
      if (signal.aborted) throw new GenerationError("Cancelled", "cancelled");
      // A submit that timed out may still have been accepted; queueing it again
      // would render twice and bill twice the GPU seconds.
      const exists = await promptExists(base, promptId);
      if (exists === true) return promptId;
      if (exists == null || attempt === MAX_ATTEMPTS) throw error;
      await sleep(backoff(attempt), signal);
    }
  }
  return promptId;
}

interface ComfyOutput {
  bytes: Buffer;
  mime: string;
  filename: string;
  kind: "image" | "video";
}

async function describeQueue(base: string, promptId: string) {
  try {
    const response = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return undefined;
    const queue = (await response.json()) as {
      queue_running?: unknown[][];
      queue_pending?: unknown[][];
    };
    const running = (queue.queue_running ?? []).some((entry) => entry?.includes?.(promptId));
    if (running) return "渲染中";
    const ahead = (queue.queue_pending ?? []).findIndex((entry) => entry?.includes?.(promptId));
    if (ahead >= 0) return `排队中，前面还有 ${ahead}`;
  } catch {
    return undefined;
  }
  return undefined;
}

async function waitForOutput(
  base: string,
  promptId: string,
  ctx: GenerationContext,
): Promise<ComfyOutput> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastNote = "";
  while (true) {
    if (ctx.signal.aborted) throw new GenerationError("Cancelled", "cancelled");
    if (Date.now() > deadline) throw new GenerationError(`ComfyUI prompt ${promptId} timed out`, "timeout");
    const history = (await (
      await comfy(base, `/history/${encodeURIComponent(promptId)}`, { signal: ctx.signal })
    ).json()) as Record<string, { outputs?: Record<string, ComfyNodeOutput>; status?: ComfyStatus }>;
    const record = history[promptId];
    if (record) {
      const found = await collect(base, record.outputs ?? {}, ctx.signal);
      if (found) return found;
      if (record.status?.status_str === "error") {
        throw new GenerationError(`ComfyUI failed: ${JSON.stringify(record.status)}`, "upstream_error");
      }
      if (record.status?.completed === true || record.status?.status_str === "success") {
        throw new GenerationError(`ComfyUI prompt ${promptId} produced no output`, "upstream_error");
      }
    }
    const note = await describeQueue(base, promptId);
    if (note && note !== lastNote) {
      lastNote = note;
      ctx.progress(null, note);
    }
    await sleep(POLL_MS, ctx.signal);
  }
}

interface ComfyStatus {
  status_str?: string;
  completed?: boolean;
}

interface ComfyNodeOutput {
  images?: Array<{ filename: string; subfolder?: string; type?: string }>;
  gifs?: Array<{ filename: string; subfolder?: string; type?: string; format?: string }>;
  videos?: Array<{ filename: string; subfolder?: string; type?: string }>;
}

async function collect(
  base: string,
  outputs: Record<string, ComfyNodeOutput>,
  signal: AbortSignal,
): Promise<ComfyOutput | undefined> {
  for (const output of Object.values(outputs)) {
    for (const entry of output.videos ?? output.gifs ?? []) {
      const bytes = await view(base, entry, signal);
      return { bytes: bytes.body, mime: bytes.mime, filename: entry.filename, kind: "video" };
    }
    for (const entry of output.images ?? []) {
      const full = await view(base, entry, signal);
      return { bytes: full.body, mime: full.mime, filename: entry.filename, kind: "image" };
    }
  }
  return undefined;
}

async function view(base: string, entry: { filename: string; subfolder?: string; type?: string }, signal: AbortSignal) {
  const query = new URLSearchParams({
    filename: entry.filename,
    subfolder: entry.subfolder ?? "",
    type: entry.type ?? "output",
  });
  const response = await comfy(base, `/view?${query}`, { signal });
  return {
    body: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get("content-type")?.split(";")[0] ?? "image/png",
  };
}

async function upload(base: string, source: { bytes: Buffer; mime: string }, signal: AbortSignal) {
  const name = `luma-source-${randomUUID()}.${source.mime.includes("jpeg") ? "jpg" : "png"}`;
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(source.bytes)], { type: source.mime }), name);
  form.append("overwrite", "false");
  form.append("type", "input");
  const response = await comfy(base, "/upload/image", { method: "POST", body: form, signal });
  const result = (await response.json()) as { name?: string };
  return result.name ?? name;
}

function pickSize(config: ComfyParams, request: GenerationRequest) {
  const sizes = sizesIn(config);
  const width = Number(request.params.width ?? 0);
  const height = Number(request.params.height ?? 0);
  if (width && height) {
    const limit = config.maxPixels ?? DEFAULT_MAX_PIXELS;
    if (width * height > limit) {
      throw new GenerationError(`${width}×${height} is above this workflow's pixel budget`, "invalid_request");
    }
    return [width, height] as [number, number];
  }
  const ratio = String(request.params.aspect_ratio ?? "auto");
  return sizes[ratio] ?? sizes.auto ?? [1024, 1024];
}

export const comfyAdapter: GenerationAdapter = {
  id: "comfy-workflow",

  // A workflow is whatever its graph says, so every op is reachable here; the
  // model row is what narrows it.
  runs: ["text_to_image", "image_to_image", "text_to_video", "image_to_video"],

  schema(spec, op) {
    const config = configOf(spec);
    const bindings = config.bind ?? {};
    const properties: Record<string, JsonSchema> = {
      prompt: promptField(op === "image_to_image" ? "改成什么样" : "画面描述", 32_000),
    };
    if (op === "image_to_image" || op === "image_to_video") {
      properties.source_image_id = {
        type: "string",
        title: "源图片",
        description: "Copy an exact image_id from the conversation.",
      };
    }
    if (op === "text_to_image" || op === "text_to_video") {
      properties.aspect_ratio = {
        type: "string",
        title: "画幅",
        enum: Object.keys(sizesIn(config)),
        default: "auto",
      };
    }
    if (bindings.width && bindings.height) {
      properties.width = { type: "string", title: "宽（可留空，跟随画幅）" };
      properties.height = { type: "string", title: "高（可留空，跟随画幅）" };
    }
    // Everything else the graph both binds and describes. A knob is offered
    // because the workflow says it has one, never because this file names it.
    for (const [name, control] of Object.entries(config.controls ?? {})) {
      if (properties[name] || STRUCTURAL.has(name) || !bindings[name]) continue;
      properties[name] = control;
    }
    return {
      type: "object",
      properties,
      required: properties.source_image_id ? ["prompt", "source_image_id"] : ["prompt"],
    };
  },

  async run(request, ctx): Promise<GenerationResult> {
    const base = request.provider.baseUrl.replace(/\/+$/, "");
    const spec = request.spec;
    const raw = readWorkflow(spec);
    const config = configOf(spec, raw);
    const bindings = config.bind ?? {};
    const graph = loadGraph(raw);
    const editing = request.op === "image_to_image" || request.op === "image_to_video";

    bind(graph, bindings.prompt, request.prompt);
    bind(graph, bindings[SEED], seedFor(request));
    for (const [name, control] of Object.entries(config.controls ?? {})) {
      if (STRUCTURAL.has(name) || name === SEED) continue;
      const value = knobValue(request.params[name] ?? control.default, control);
      if (value !== undefined) bind(graph, bindings[name], value);
    }

    let width: number | null = null;
    let height: number | null = null;
    if (editing) {
      const source = request.sources[0];
      if (!source) throw new GenerationError("This operation needs a source image", "invalid_request");
      const name = await upload(base, source, ctx.signal);
      if (!bind(graph, bindings.source, name)) {
        throw new GenerationError(`${spec.name} has no source binding`, "not_configured");
      }
      const pixels = (source.width ?? 0) * (source.height ?? 0);
      const ceiling = config.editMegapixels ?? 1.8;
      const megapixels = pixels ? Math.min(pixels / 1_000_000, ceiling) : ceiling;
      bind(graph, bindings.megapixels, Number(megapixels.toFixed(3)));
    } else {
      [width, height] = pickSize(config, request);
      bind(graph, bindings.width, width);
      bind(graph, bindings.height, height);
    }

    const promptId = await queueUp(base, graph, randomUUID(), ctx.signal);
    ctx.adopt(promptId);
    ctx.progress(null, "已提交");
    try {
      const output = await waitForOutput(base, promptId, ctx);
      if (output.kind === "video") {
        // The first frame of an image-to-video is the still a client can show
        // before the bytes arrive, exactly as it is for a hosted render.
        const posterImageId = request.sources[0]?.imageId ?? null;
        const videoId = saveVideoBytes(ctx.store, output.bytes, {
          mime: output.mime,
          provider: request.provider.id,
          model: spec.model,
          width,
          height,
          posterImageId,
          parents: request.sources.map((source) => source.imageId),
        });
        return {
          assets: [
            { assetId: videoId, kind: "video", mime: output.mime, width, height, posterAssetId: posterImageId },
          ],
          providerRequestId: promptId,
        };
      }
      const imageId = await saveImageBytes(ctx.store, output.bytes, {
        mime: output.mime,
        provider: request.provider.id,
        model: spec.model,
        width,
        height,
        parents: request.sources.map((source) => source.imageId),
      });
      return {
        assets: [{ assetId: imageId, kind: "image", mime: output.mime, width, height }],
        providerRequestId: promptId,
      };
    } catch (error) {
      await cancelPrompt(base, promptId);
      throw error;
    }
  },

  async cancel(providerJobId, ctx) {
    await cancelPrompt(ctx.baseUrl.replace(/\/+$/, ""), providerJobId);
  },
};
