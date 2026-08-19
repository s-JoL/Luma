/**
 * OpenAI-shaped image endpoints: `/images/generations` and `/images/edits`.
 *
 * The edit half is what was missing. A hosted editor could be discovered in a
 * provider's catalogue and saved as a model row, and then only ever draw from
 * nothing, because the one code path posted a JSON body to the generations
 * endpoint. Edits are multipart with the source image attached, which is why
 * they need their own request rather than another field.
 */
import type { GenerationOp, JsonSchema, ModelSpec } from "@shared/types.ts";
import { saveImageBytes } from "../images.ts";
import { download, request as http } from "./http.ts";
import {
  GenerationError,
  promptField,
  type GenerationAdapter,
  type GenerationContext,
  type GenerationRequest,
  type GenerationResult,
} from "./types.ts";

const TIMEOUT_MS = 300_000;

/** Sizes every OpenAI-compatible endpoint accepts, plus the wide pair. */
const DEFAULT_SIZES = ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "2048x2048"];

interface ImageParams {
  sizes?: string[];
  /** Extra body fields a gateway needs, e.g. `{ "quality": "high" }`. */
  extra?: Record<string, unknown>;
  /** Set when the gateway wants `response_format: "b64_json"` spelled out. */
  responseFormat?: string;
}

const params = (spec: ModelSpec) => (spec.params ?? {}) as ImageParams;
const sizesOf = (spec: ModelSpec) => params(spec).sizes ?? DEFAULT_SIZES;

interface ImagePayload {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
}

async function bytesOf(entry: { url?: string; b64_json?: string }, ctx: GenerationContext) {
  if (entry.b64_json) return { bytes: Buffer.from(entry.b64_json, "base64"), mime: "image/png" };
  if (!entry.url) throw new GenerationError("The provider returned no image", "upstream_error");
  return download(entry.url, ctx.signal, "the image host");
}

function sizeOf(spec: ModelSpec, request: GenerationRequest) {
  const sizes = sizesOf(spec);
  const asked = String(request.params.size ?? "");
  return sizes.includes(asked) ? asked : (sizes[0] ?? "1024x1024");
}

async function readPayload(response: Response, spec: ModelSpec) {
  const payload = (await response.json().catch(() => ({}))) as ImagePayload;
  if (!response.ok) {
    throw new GenerationError(payload.error?.message ?? `${spec.name} returned ${response.status}`, "upstream_error");
  }
  const entry = payload.data?.[0];
  if (!entry) throw new GenerationError(payload.error?.message ?? "The provider returned no image", "upstream_error");
  return entry;
}

export const openAiImagesAdapter: GenerationAdapter = {
  id: "openai-images",
  runs: ["text_to_image", "image_to_image"],

  schema(spec, op) {
    const properties: Record<string, JsonSchema> = {
      prompt: promptField(op === "image_to_image" ? "改成什么样" : "画面描述"),
      size: { type: "string", title: "尺寸", enum: sizesOf(spec), default: sizesOf(spec)[0] },
    };
    if (op === "image_to_image") {
      properties.source_image_id = {
        type: "string",
        title: "源图片",
        description: "Copy an exact image_id from the conversation.",
      };
    }
    return {
      type: "object",
      properties,
      required: op === "image_to_image" ? ["prompt", "source_image_id"] : ["prompt"],
    };
  },

  async run(request, ctx): Promise<GenerationResult> {
    const { spec, provider } = request;
    const base = provider.baseUrl.replace(/\/+$/, "");
    if (!ctx.apiKey) throw new GenerationError(`${provider.name} has no API key configured`, "not_configured");
    const size = sizeOf(spec, request);
    const extra = params(spec).extra ?? {};
    ctx.progress(null, "已提交");

    let response: Response;
    if (request.op === "image_to_image") {
      const source = request.sources[0];
      if (!source) throw new GenerationError("This operation needs a source image", "invalid_request");
      response = await http(`${base}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}` },
        // Rebuilt per attempt: a consumed multipart body cannot be resent.
        bodyOf: () => {
          const form = new FormData();
          form.append("model", spec.model);
          form.append("prompt", request.prompt);
          form.append("size", size);
          form.append("n", "1");
          for (const [key, value] of Object.entries(extra)) form.append(key, String(value));
          // Every source is attached: gateways that only read the first ignore
          // the rest, and the ones that compose need them all.
          for (const [index, image] of request.sources.entries()) {
            form.append(
              index === 0 ? "image" : "image[]",
              new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
              `${image.imageId}.${image.mime.includes("jpeg") ? "jpg" : "png"}`,
            );
          }
          return form;
        },
        cancel: ctx.signal,
        timeoutMs: TIMEOUT_MS,
        label: spec.name,
      });
    } else {
      response = await http(`${base}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: spec.model,
          prompt: request.prompt,
          size,
          n: 1,
          ...(params(spec).responseFormat ? { response_format: params(spec).responseFormat } : {}),
          ...extra,
        }),
        cancel: ctx.signal,
        timeoutMs: TIMEOUT_MS,
        label: spec.name,
      });
    }

    const entry = await readPayload(response, spec);
    const { bytes, mime } = await bytesOf(entry, ctx);
    const [width, height] = size.split("x").map(Number);
    const imageId = await saveImageBytes(ctx.store, bytes, {
      mime,
      provider: provider.id,
      model: spec.model,
      width: width ?? null,
      height: height ?? null,
      parents: request.sources.map((source) => source.imageId),
    });
    return {
      assets: [{ assetId: imageId, kind: "image", mime, width: width ?? null, height: height ?? null }],
      effective: { size },
    };
  },
};

