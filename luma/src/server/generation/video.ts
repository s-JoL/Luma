/**
 * Asynchronous video, in the shape every provider of it has converged on:
 * submit, poll, fetch. Seedance, Sora and Kling differ in their field names and
 * their route names but not in that sequence, so the routes and a few field
 * aliases are declared on the model row instead of forking the adapter:
 *
 *   { "submitPath": "/videos", "statusPath": "/videos/{id}",
 *     "contentPath": "/videos/{id}/content", "submitFormat": "multipart",
 *     "sourceField": "input_reference",
 *     "durations": [4, 8], "sizes": ["1280x720", "720x1280"] }
 *
 * The polling loop is the reason `jobs.provider_job_id` exists. A render can
 * outlive a redeploy, and a job that knows the backend's id for its work can be
 * picked back up instead of paid for twice.
 */
import type { JsonSchema, ModelSpec } from "@shared/types.ts";
import { saveVideoBytes } from "../images.ts";
import { request as http } from "./http.ts";
import {
  GenerationError,
  promptField,
  type GenerationAdapter,
  type GenerationContext,
  type GenerationRequest,
  type GenerationResult,
} from "./types.ts";

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const TOTAL_TIMEOUT_MS = 30 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
/**
 * Polls that go unanswered in a row before the render is given up on. At the
 * interval above this is the ~50s a provider is allowed to be unreachable, which
 * has to outlast a redeploy on the other side: giving up after 25s threw away
 * renders that were still running and still billed.
 */
const MAX_POLL_FAILURES = 10;

/**
 * How providers spell "finished" and "gave up", and how a model row overrides
 * them. These are defaults, not the vocabulary: Kling says `succeed`, which is
 * in neither set, and a compiled-in list means the next provider to invent a
 * word costs a code change. What actually ends the poll is finding the video —
 * the words only decide how quickly failure is reported.
 */
const DONE = new Set(["completed", "succeeded", "success", "done"]);
const DEAD = new Set(["failed", "error", "cancelled", "canceled", "rejected"]);

interface VideoParams {
  submitPath?: string;
  statusPath?: string;
  contentPath?: string;
  doneStates?: string[];
  failedStates?: string[];
  durations?: number[];
  sizes?: string[];
  extra?: Record<string, unknown>;
  /**
   * Seedance on CometAPI declares its submit as `multipart/form-data` only, and
   * carries reference frames as uploaded files rather than data URIs. Sora takes
   * JSON. The sequence is identical either way, so the encoding is a row's
   * declaration rather than a second adapter.
   */
  submitFormat?: "json" | "multipart";
  /** Field the reference frames go in — `input_reference` for Seedance. */
  sourceField?: string;
  /** References this model accepts; above one the schema offers the extra slots. */
  maxSources?: number;
}

const states = (configured: string[] | undefined, fallback: Set<string>) =>
  configured?.length ? new Set(configured.map((state) => state.toLowerCase())) : fallback;

const params = (spec: ModelSpec) => (spec.params ?? {}) as VideoParams;
const maxSourcesOf = (spec: ModelSpec) => Math.max(1, params(spec).maxSources ?? 1);
const route = (template: string, id: string) => template.replaceAll("{id}", encodeURIComponent(id));

const pick = (value: unknown, ...keys: string[]): unknown => {
  const record = value as Record<string, unknown> | null;
  if (!record) return undefined;
  for (const key of keys) if (record[key] != null) return record[key];
  return undefined;
};

/**
 * Providers wrap the interesting part in `data`, `task`, `result` or nothing.
 * The inner object wins the merge: an envelope that carries its own `status: ok`
 * around a `data.status: running` would otherwise report a state that is neither
 * finished nor failed, and the render would poll until the half-hour ran out.
 */
function unwrap(payload: unknown) {
  const record = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["data", "task", "result", "video"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return { ...record, ...(nested as Record<string, unknown>) };
    }
  }
  return record;
}

/** The first absolute http(s) string anywhere in the payload, breadth first. */
function findUrl(payload: unknown, depth = 0): string | undefined {
  if (typeof payload === "string") return /^https?:\/\//i.test(payload) ? payload : undefined;
  if (depth > 6 || !payload || typeof payload !== "object") return undefined;
  for (const value of Object.values(payload as Record<string, unknown>)) {
    const found = findUrl(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function videoUrlOf(payload: Record<string, unknown>): string | undefined {
  const direct = pick(payload, "url", "video_url", "videoUrl", "download_url");
  if (typeof direct === "string") return direct;
  for (const key of ["outputs", "videos", "content", "results"]) {
    const list = payload[key];
    if (Array.isArray(list) && list.length) {
      const first = list[0] as Record<string, unknown> | string;
      if (typeof first === "string") return first;
      const nested = pick(first, "url", "video_url", "videoUrl");
      if (typeof nested === "string") return nested;
    }
  }
  // Kling nests its result at `data.task_result.videos[0].url`, and the next
  // provider will nest it somewhere else again. Naming every shape is a losing
  // game; a finished render is the payload that contains a link.
  return findUrl(payload);
}

/** A submit's encoding, resolved from the row before the request is built. */
interface Submission {
  headers: Record<string, string>;
  bodyOf: () => BodyInit;
}

async function post(url: string, apiKey: string, submission: Submission, signal: AbortSignal) {
  const response = await http(url, {
    method: "POST",
    // No content-type for multipart: fetch has to write the boundary itself.
    headers: { authorization: `Bearer ${apiKey}`, ...submission.headers },
    bodyOf: submission.bodyOf,
    cancel: signal,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    // Never retried: a submit that may already have been accepted would queue a
    // second paid render, and the poll below is how a lost answer is recovered.
    attempts: 1,
    label: "Video submit",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new GenerationError(`Video submit returned ${response.status}: ${text.slice(0, 300)}`, "upstream_error");
  }
  try {
    return unwrap(JSON.parse(text));
  } catch {
    throw new GenerationError("Video submit returned a body that is not JSON", "upstream_error");
  }
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

async function fetchStatus(base: string, spec: ModelSpec, id: string, apiKey: string, signal: AbortSignal) {
  const path = params(spec).statusPath ?? "/videos/{id}";
  const response = await http(`${base}${route(path, id)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    cancel: signal,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    label: "Video status",
  });
  if (!response.ok) {
    throw new GenerationError(`Video status returned ${response.status}`, "upstream_error");
  }
  return unwrap(await response.json());
}

async function fetchVideo(url: string, signal: AbortSignal) {
  const response = await http(url, { cancel: signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, label: "the video host" });
  if (!response.ok) throw new GenerationError(`Downloading the video failed with ${response.status}`, "upstream_error");
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get("content-type")?.split(";")[0] ?? "video/mp4",
  };
}

/**
 * Waits for a submitted render. Exported so job recovery after a restart can
 * rejoin a render it did not submit.
 */
export async function awaitVideo(
  request: GenerationRequest,
  ctx: GenerationContext,
  providerJobId: string,
): Promise<GenerationResult> {
  const { spec, provider } = request;
  const base = provider.baseUrl.replace(/\/+$/, "");
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (true) {
    if (ctx.signal.aborted) throw new GenerationError("Cancelled", "cancelled");
    if (Date.now() > deadline) throw new GenerationError("The render did not finish in 30 minutes", "timeout");
    // A poll that cannot be answered is not a render that failed: the backend
    // is still working and we are the ones who lost the connection.
    let status: Record<string, unknown>;
    try {
      status = await fetchStatus(base, spec, providerJobId, ctx.apiKey, ctx.signal);
      consecutiveFailures = 0;
    } catch (error) {
      if (error instanceof GenerationError && error.code === "cancelled") throw error;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_POLL_FAILURES) throw error;
      ctx.progress(null, "等待提供方响应");
      await sleep(POLL_INTERVAL_MS, ctx.signal);
      continue;
    }
    const state = String(pick(status, "status", "state", "task_status") ?? "").toLowerCase();
    const progress = Number(pick(status, "progress", "percent") ?? Number.NaN);
    if (Number.isFinite(progress)) ctx.progress(progress > 1 ? progress / 100 : progress, state || undefined);
    else ctx.progress(null, state || undefined);

    if (states(params(spec).failedStates, DEAD).has(state)) {
      const message = pick(status, "error", "failure_reason", "message");
      throw new GenerationError(
        typeof message === "string" ? message : `The provider reported ${state || "failure"}`,
        "upstream_error",
      );
    }
    if (states(params(spec).doneStates, DONE).has(state) || videoUrlOf(status)) {
      const url = videoUrlOf(status);
      const output = url
        ? await fetchVideo(url, ctx.signal)
        : await fetchVideo(`${base}${route(params(spec).contentPath ?? "/videos/{id}/content", providerJobId)}`, ctx.signal);
      const size = String(request.params.size ?? "");
      const [width, height] = size.includes("x") ? size.split("x").map(Number) : [null, null];
      const seconds = Number(request.params.duration ?? Number.NaN);
      const videoId = saveVideoBytes(ctx.store, output.bytes, {
        mime: output.mime,
        provider: provider.id,
        model: spec.model,
        width: width ?? null,
        height: height ?? null,
        durationMs: Number.isFinite(seconds) ? seconds * 1000 : null,
        posterImageId: request.sources[0]?.imageId ?? null,
        parents: request.sources.map((source) => source.imageId),
      });
      return {
        assets: [
          {
            assetId: videoId,
            kind: "video",
            mime: output.mime,
            width: width ?? null,
            height: height ?? null,
            durationMs: Number.isFinite(seconds) ? seconds * 1000 : null,
            posterAssetId: request.sources[0]?.imageId ?? null,
          },
        ],
        providerRequestId: providerJobId,
      };
    }
    await sleep(POLL_INTERVAL_MS, ctx.signal);
  }
}

export const videoAdapter: GenerationAdapter = {
  id: "openai-videos",

  runs: ["text_to_video", "image_to_video"],

  schema(spec, op) {
    const properties: Record<string, JsonSchema> = {
      prompt: promptField("镜头描述"),
    };
    const sizes = params(spec).sizes;
    if (sizes?.length) properties.size = { type: "string", title: "分辨率", enum: sizes, default: sizes[0] };
    const durations = params(spec).durations;
    if (durations?.length) {
      properties.duration = { type: "integer", title: "时长（秒）", enum: durations, default: durations[0] };
    }
    if (op === "image_to_video") {
      properties.source_image_id = {
        type: "string",
        title: "参考图 / 首帧",
        description: "Copy an exact image_id from the conversation.",
      };
      const extras = maxSourcesOf(spec) - 1;
      if (extras > 0) {
        properties.additional_source_image_ids = {
          type: "array",
          title: `追加参考图（最多 ${extras} 张，按顺序）`,
          description: "Ordered references beyond the first. Name them in the prompt as [Image 2] onward.",
          items: { type: "string" },
          maxItems: extras,
        };
      }
    }
    return {
      type: "object",
      properties,
      required: op === "image_to_video" ? ["prompt", "source_image_id"] : ["prompt"],
    };
  },

  async run(request, ctx): Promise<GenerationResult> {
    const { spec, provider } = request;
    const base = provider.baseUrl.replace(/\/+$/, "");
    if (!ctx.apiKey) throw new GenerationError(`${provider.name} has no API key configured`, "not_configured");
    if (request.op === "image_to_video" && !request.sources.length) {
      throw new GenerationError("This operation needs a first frame", "invalid_request");
    }

    const fields: Record<string, unknown> = {
      model: spec.model,
      prompt: request.prompt,
      ...(request.params.size ? { size: request.params.size } : {}),
      ...(request.params.duration ? { seconds: String(request.params.duration) } : {}),
      ...(params(spec).extra ?? {}),
    };
    const sources = request.sources;
    if (sources.length > maxSourcesOf(spec)) {
      throw new GenerationError(`${spec.name} accepts at most ${maxSourcesOf(spec)} reference images`, "invalid_request");
    }
    const sourceField = params(spec).sourceField ?? "image";
    const submission: Submission =
      params(spec).submitFormat === "multipart"
        ? {
            headers: {},
            bodyOf: () => {
              const form = new FormData();
              for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
              // Repeating the field is how the order is expressed: the backend
              // numbers the uploads, and the prompt refers to them by that order.
              for (const image of sources) {
                form.append(
                  sourceField,
                  new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
                  `${image.imageId}.${image.mime.includes("jpeg") ? "jpg" : "png"}`,
                );
              }
              return form;
            },
          }
        : {
            headers: { "content-type": "application/json" },
            bodyOf: () =>
              JSON.stringify({
                ...fields,
                ...(sources[0]
                  ? { [sourceField]: `data:${sources[0].mime};base64,${sources[0].bytes.toString("base64")}` }
                  : {}),
              }),
          };

    const submitted = await post(
      `${base}${params(spec).submitPath ?? "/videos"}`,
      ctx.apiKey,
      submission,
      ctx.signal,
    );
    const providerJobId = String(pick(submitted, "id", "task_id", "taskId", "request_id") ?? "");
    if (!providerJobId) throw new GenerationError("The provider did not return a task id", "upstream_error");
    // Recorded before the first poll: from here on the render survives us.
    ctx.adopt(providerJobId);
    ctx.progress(null, "已提交");
    return awaitVideo(request, ctx, providerJobId);
  },
};
