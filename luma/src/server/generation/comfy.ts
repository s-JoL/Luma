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
 *
 * Progress comes from ComfyUI's WebSocket, which is the only place it exists —
 * `/queue` knows running from pending and nothing finer. That socket reports the
 * stage and the step count; it never decides whether the render finished, which
 * is still read from `/history`, so a backend that will not upgrade the
 * connection loses the detail and nothing else.
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

/**
 * What a node is doing, in the words someone waiting for it would use. Matched on
 * the class name because that is what the graph carries, and an unrecognised node
 * reports its own class rather than a guess — which is how a workflow full of
 * custom nodes stays legible instead of reading "执行中" for four minutes.
 */
const STAGES: Array<[RegExp, string]> = [
  [/Checkpoint|UNET|Diffusion.*Loader|VAELoader|CLIPLoader|Lora|ControlNetLoader|GGUF/i, "加载模型"],
  [/LoadImage|ImageScale|ImageBatch|Crop/i, "准备输入"],
  [/CLIPText|TextEncode|Conditioning/i, "编码提示词"],
  [/Sampler|Guider|CFG/i, "采样"],
  [/Decode|Upscale/i, "解码放大"],
  [/Save|Preview|Output/i, "保存"],
];

function stageOf(graph: Record<string, { class_type?: string }>, node: string) {
  const type = graph[node]?.class_type ?? "";
  for (const [pattern, label] of STAGES) if (pattern.test(type)) return label;
  return type || "执行中";
}

/** How long a running prompt may say nothing before the wait admits it is stuck. */
const STALL_MS = 90_000;

interface ComfyMessage {
  type?: string;
  data?: { prompt_id?: string; node?: string | null; value?: number; max?: number };
}

/** What the socket has told us so far. Read by the poll, written by the socket. */
interface Live {
  /** When this prompt was last mentioned, which is how a stall is detected. */
  at: number;
  /** True once the upgrade succeeded; false means fall back to the queue's words. */
  connected: boolean;
  /** True once a node of ours has executed, which ends the cold start. */
  executing: boolean;
  fraction: number | null;
  stage: string;
  close(): void;
}

/**
 * ComfyUI reports what it is actually doing over a WebSocket and nowhere else:
 * `/queue` distinguishes running from pending and nothing finer, so "loading the
 * weights" and "step 3 of 8" cannot be had over HTTP at all.
 *
 * So this is an enhancement and never the source of truth. Completion is still
 * read from `/history` by the poll below, which means a backend that refuses the
 * upgrade — an old build, a reverse proxy that drops it — behaves exactly as it
 * did before any of this, reporting the queue position it always reported.
 */
function follow(base: string, promptId: string, graph: Record<string, { class_type?: string }>): Live {
  const live: Live = {
    at: Date.now(),
    connected: false,
    executing: false,
    fraction: null,
    stage: "",
    close: () => {},
  };
  let socket: WebSocket;
  try {
    // Every client is broadcast every event, so the prompt id serves as the client
    // id rather than inventing a second identifier to correlate afterwards.
    socket = new WebSocket(`${base.replace(/^http/i, "ws")}/ws?clientId=${encodeURIComponent(promptId)}`);
  } catch {
    return live;
  }
  live.close = () => {
    try {
      socket.close();
    } catch {
      // Already closed by the backend, or never opened at all.
    }
  };
  socket.onopen = () => {
    live.connected = true;
  };
  // A socket that drops is not an error worth surfacing: the poll is still
  // reading `/history`, so the render is followed either way.
  socket.onerror = () => {};
  socket.onmessage = (event) => {
    let message: ComfyMessage;
    try {
      message = JSON.parse(String(event.data)) as ComfyMessage;
    } catch {
      // Preview frames arrive on the same socket as binary. They are not status.
      return;
    }
    const data = message.data ?? {};
    // Anything without our id belongs to another client's render, including the
    // queue-length broadcasts. Counting those as activity would hide a stall.
    if (data.prompt_id !== promptId) return;
    live.at = Date.now();
    if (message.type === "execution_start") live.executing = true;
    if (message.type === "executing" && data.node) {
      live.executing = true;
      live.stage = stageOf(graph, data.node);
      // A new node starts over; the old node's step count is not this one's.
      live.fraction = null;
    }
    if (message.type === "progress" && typeof data.value === "number" && data.max) {
      live.executing = true;
      live.fraction = Math.min(1, Math.max(0, data.value / data.max));
      if (data.node) live.stage = stageOf(graph, data.node);
    }
  };
  return live;
}

async function waitForOutput(
  base: string,
  promptId: string,
  live: Live,
  ctx: GenerationContext,
): Promise<ComfyOutput> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastNote = "";
  let lastFraction: number | null = null;
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
    // What the socket says beats what the queue says, because "采样" with a step
    // count is the render itself while "渲染中" is only the queue's word for it.
    // Before any node has executed, a prompt the queue calls running is the
    // process warming up and the weights coming off disk — on a cold start that
    // is most of the wait, and the one stage worth naming out loud.
    let note = "";
    if (live.executing) {
      note = live.stage || "执行中";
    } else {
      const position = await describeQueue(base, promptId);
      note = live.connected && position === "渲染中" ? "启动中，加载模型" : (position ?? "");
    }

    // A local render that has gone quiet is either a slow sampler or a wedged
    // backend, and from the outside those look identical. Saying how long the
    // silence has lasted is the honest version: it lets the reader decide to
    // cancel instead of watching a bar that will never move again. Counted in
    // half-minutes, because a figure that ticks every second is a row rewritten
    // every second to say the same thing.
    const silent = Date.now() - live.at;
    if (live.executing && silent > STALL_MS) {
      note = `${note} · 已 ${Math.floor(silent / 30_000) / 2} 分钟没有进展`;
    }

    if (note && (note !== lastNote || live.fraction !== lastFraction)) {
      lastNote = note;
      lastFraction = live.fraction;
      ctx.progress(live.fraction, note);
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
      // Exact pixels are for a person with a reason. Offering them alongside the
      // aspect ratio let a model ask for 16:9 at 1024x1024 and mean neither.
      properties.width = { type: "string", title: "宽（可留空，跟随画幅）", audience: "studio" };
      properties.height = { type: "string", title: "高（可留空，跟随画幅）", audience: "studio" };
    }
    // Everything else the graph both binds and describes. A knob is offered
    // because the workflow says it has one, never because this file names it —
    // and to the person driving by hand, because these are the sampler, the step
    // count and the seed, which is the author's tuning rather than anything a
    // model has grounds to overrule. A workflow with a knob that is genuinely a
    // creative choice says `"audience": "both"` and gets it back.
    for (const [name, control] of Object.entries(config.controls ?? {})) {
      if (properties[name] || STRUCTURAL.has(name) || !bindings[name]) continue;
      properties[name] = { audience: "studio", ...control };
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
    const live = follow(base, promptId, graph);
    try {
      const output = await waitForOutput(base, promptId, live, ctx);
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
    } finally {
      live.close();
    }
  },

  async cancel(providerJobId, ctx) {
    await cancelPrompt(ctx.baseUrl.replace(/\/+$/, ""), providerJobId);
  },
};
