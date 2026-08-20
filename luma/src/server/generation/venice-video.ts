/** Venice's video API is a queue, but not the OpenAI `/videos/{id}` shape. */
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

const POLL_INTERVAL_MS = 5_000;
const TOTAL_TIMEOUT_MS = 30 * 60_000;

interface VeniceVideoParams {
  imageModel?: string;
  durations?: number[];
  resolutions?: string[];
  aspectRatios?: string[];
  imageAspectRatios?: string[];
  sourceField?: "image_url" | "reference_image_urls";
  promptMax?: number;
  pollIntervalMs?: number;
  extra?: Record<string, unknown>;
  promptHints?: string;
}

interface AdoptedJob {
  queueId: string;
  downloadUrl?: string;
}

const params = (spec: ModelSpec) => (spec.params ?? {}) as VeniceVideoParams;
const baseOf = (request: GenerationRequest) => request.provider.baseUrl.replace(/\/+$/, "");
const modelOf = (request: GenerationRequest) =>
  request.op === "image_to_video" ? params(request.spec).imageModel ?? request.spec.model : request.spec.model;

function adopted(value: string): AdoptedJob {
  try {
    const parsed = JSON.parse(value) as Partial<AdoptedJob>;
    if (typeof parsed.queueId === "string" && parsed.queueId) return parsed as AdoptedJob;
  } catch {
    // Rows created before download URLs were persisted contain the queue id alone.
  }
  return { queueId: value };
}

async function errorMessage(response: Response, label: string) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
    const nested = typeof payload.error === "object" ? payload.error.message : payload.error;
    return nested || payload.message || `${label} returned ${response.status}`;
  } catch {
    return text.slice(0, 300) || `${label} returned ${response.status}`;
  }
}

const sleep = (signal: AbortSignal, milliseconds: number) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GenerationError("Cancelled", "cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

async function cleanup(request: GenerationRequest, ctx: GenerationContext, queueId: string, model: string) {
  await http(`${baseOf(request)}/video/complete`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, queue_id: queueId }),
    cancel: ctx.signal,
    attempts: 1,
    timeoutMs: 30_000,
    label: "Venice video cleanup",
  }).catch(() => undefined);
}

async function awaitVeniceVideo(
  request: GenerationRequest,
  ctx: GenerationContext,
  providerJobId: string,
): Promise<GenerationResult> {
  const owned = adopted(providerJobId);
  const model = modelOf(request);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const response = await http(`${baseOf(request)}/video/retrieve`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, queue_id: owned.queueId, delete_media_on_completion: false }),
      cancel: ctx.signal,
      timeoutMs: 60_000,
      label: "Venice video retrieve",
    });
    if (!response.ok) throw new GenerationError(await errorMessage(response, "Venice video retrieve"), "upstream_error");

    const mime = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
    let bytes: Buffer | undefined;
    if (mime.startsWith("video/")) {
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      const payload = (await response.json()) as Record<string, unknown>;
      const state = String(payload.status ?? "PROCESSING").toUpperCase();
      const elapsed = Number(payload.execution_duration ?? Number.NaN);
      const expected = Number(payload.average_execution_time ?? Number.NaN);
      ctx.progress(
        Number.isFinite(elapsed) && Number.isFinite(expected) && expected > 0
          ? Math.min(0.99, elapsed / expected)
          : null,
        state.toLowerCase(),
      );
      if (["FAILED", "ERROR", "CANCELLED", "REJECTED"].includes(state)) {
        const error = payload.error;
        const nested = typeof error === "object" && error ? (error as { message?: unknown }).message : undefined;
        throw new GenerationError(
          typeof error === "string"
            ? error
            : typeof nested === "string"
              ? nested
              : `Venice reported ${state.toLowerCase()}`,
          "upstream_error",
        );
      }
      if (state === "COMPLETED") {
        if (!owned.downloadUrl) {
          throw new GenerationError("Venice completed the render without returning video bytes or a download URL", "upstream_error");
        }
        const output = await http(owned.downloadUrl, {
          cancel: ctx.signal,
          timeoutMs: 300_000,
          label: "Venice video download",
        });
        if (!output.ok) throw new GenerationError(`Venice video download returned ${output.status}`, "upstream_error");
        bytes = Buffer.from(await output.arrayBuffer());
      }
    }

    if (bytes) {
      const seconds = Number(request.params.duration ?? Number.NaN);
      const outputMime = mime.startsWith("video/") ? mime : "video/mp4";
      const videoId = saveVideoBytes(ctx.store, bytes, {
        mime: outputMime,
        provider: request.provider.id,
        model,
        width: null,
        height: null,
        durationMs: Number.isFinite(seconds) ? seconds * 1000 : null,
        posterImageId: request.sources[0]?.imageId ?? null,
        parents: request.sources.map((source) => source.imageId),
      });
      await cleanup(request, ctx, owned.queueId, model);
      return {
        assets: [
          {
            assetId: videoId,
            kind: "video",
            mime: outputMime,
            width: null,
            height: null,
            durationMs: Number.isFinite(seconds) ? seconds * 1000 : null,
            posterAssetId: request.sources[0]?.imageId ?? null,
          },
        ],
        providerRequestId: owned.queueId,
      };
    }
    await sleep(ctx.signal, params(request.spec).pollIntervalMs ?? POLL_INTERVAL_MS);
  }
  throw new GenerationError("The Venice render did not finish in 30 minutes", "timeout");
}

export const veniceVideoAdapter: GenerationAdapter = {
  id: "venice-videos",
  runs: ["text_to_video", "image_to_video"],

  schema(spec, op) {
    const configured = params(spec);
    const properties: Record<string, JsonSchema> = {
      prompt: promptField("镜头描述", configured.promptMax ?? 2_500, configured.promptHints),
      duration: {
        type: "integer",
        title: "时长（秒）",
        enum: configured.durations ?? [5, 10],
        default: configured.durations?.[0] ?? 5,
      },
      resolution: {
        type: "string",
        title: "分辨率",
        enum: configured.resolutions ?? ["720p"],
        default: configured.resolutions?.[0] ?? "720p",
      },
      aspect_ratio: {
        type: "string",
        title: "画幅",
        enum: configured.aspectRatios ?? ["16:9", "9:16", "1:1"],
        default: configured.aspectRatios?.[0] ?? "16:9",
      },
    };
    if (op === "image_to_video") {
      properties.source_image_id = {
        type: "string",
        title: "首帧图片",
        description: "Copy an exact image_id from the conversation. Venice receives it as image_url.",
      };
    }
    return {
      type: "object",
      properties,
      required: op === "image_to_video" ? ["prompt", "source_image_id"] : ["prompt"],
    };
  },

  async run(request, ctx) {
    if (!ctx.apiKey) throw new GenerationError("Venice AI has no API key configured", "not_configured");
    if (request.op === "image_to_video" && !request.sources.length) {
      throw new GenerationError("This operation needs a first frame", "invalid_request");
    }
    const model = modelOf(request);
    const seconds = String(request.params.duration ?? 5).replace(/s$/i, "");
    const source = request.sources[0];
    const sourceField = params(request.spec).sourceField ?? "image_url";
    const sourceValue = source ? `data:${source.mime};base64,${source.bytes.toString("base64")}` : undefined;
    const payload = {
      model,
      prompt: request.prompt,
      duration: `${seconds}s`,
      ...(request.params.resolution ? { resolution: request.params.resolution } : {}),
      ...(request.params.aspect_ratio &&
      (request.op !== "image_to_video" || (params(request.spec).imageAspectRatios?.length ?? 0) > 0)
        ? { aspect_ratio: request.params.aspect_ratio }
        : {}),
      ...(sourceValue
        ? sourceField === "reference_image_urls"
          ? { reference_image_urls: [sourceValue] }
          : { image_url: sourceValue }
        : {}),
      ...(params(request.spec).extra ?? {}),
    };
    const response = await http(`${baseOf(request)}/video/queue`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      cancel: ctx.signal,
      attempts: 1,
      timeoutMs: 60_000,
      label: "Venice video queue",
    });
    if (!response.ok) throw new GenerationError(await errorMessage(response, "Venice video queue"), "upstream_error");
    const queued = (await response.json()) as Record<string, unknown>;
    const queueId = String(queued.queue_id ?? queued.id ?? "");
    if (!queueId) throw new GenerationError("Venice did not return a queue id", "upstream_error");
    const owned: AdoptedJob = {
      queueId,
      ...(typeof queued.download_url === "string" ? { downloadUrl: queued.download_url } : {}),
    };
    const providerJobId = JSON.stringify(owned);
    ctx.adopt(providerJobId);
    ctx.progress(null, "已提交");
    return awaitVeniceVideo(request, ctx, providerJobId);
  },

  resume: awaitVeniceVideo,
};
