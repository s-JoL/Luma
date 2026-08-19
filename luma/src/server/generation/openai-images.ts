/**
 * OpenAI-shaped image endpoints: `/images/generations` and `/images/edits`.
 *
 * Editing comes in more than one shape, and which one a backend speaks is
 * declared on the model row rather than guessed. `/images/edits` takes a single
 * image and an optional mask, as multipart or as a data URI in JSON. ByteDance
 * Ark and the Seedream family also expose editing as the *generations* route with
 * references in an array — that is the only shape that composes more than one
 * reference, so a model that can fuse ten images can only be reached through it.
 * `editMode` is which of those a row asks for.
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
  /** Sent only on an edit, for backends whose edit half takes its own flags. */
  editExtra?: Record<string, unknown>;
  /** Set when the gateway wants `response_format: "b64_json"` spelled out. */
  responseFormat?: string;
  /**
   * How this backend edits. `edits-multipart` is OpenAI's own shape, a multipart
   * POST to `/images/edits`. `unified` is the Seedream / ByteDance Ark shape,
   * where editing *is* the generations route with references in an array field
   * and `/images/edits` does not exist at all — posting multipart there is a 404
   * dressed up as a failed render.
   */
  editMode?: "edits-multipart" | "unified";
  /** Array field the unified shape carries its references in. */
  sourceField?: string;
  /** References as bare base64, or as a `data:` URI. Seedream wants the latter. */
  sourceEncoding?: "data-uri" | "base64";
  /** References this model accepts. Above one, the schema offers the extra slots. */
  maxSources?: number;
  promptLimit?: number;
}

/**
 * "Keep the frame you were given", spelled the way the Venice adapter already
 * spells it so one idea covers both backends. Offered on edits only: a tier like
 * `2K` is a pixel budget and the reference decides the aspect, but an explicit
 * `2048x2048` would return a square crop of a widescreen picture. Generation has
 * no frame to inherit, and letting the backend pick made the same prompt come
 * back 3:2 once and 3:4 the next time.
 */
const AUTO = "auto";

const params = (spec: ModelSpec) => (spec.params ?? {}) as ImageParams;
const sizesOf = (spec: ModelSpec, op: GenerationOp) => {
  const declared = params(spec).sizes ?? DEFAULT_SIZES;
  return op === "image_to_image" ? [AUTO, ...declared] : declared;
};
const unified = (spec: ModelSpec) => params(spec).editMode === "unified";
const maxSourcesOf = (spec: ModelSpec) => Math.max(1, params(spec).maxSources ?? 1);
const encode = (spec: ModelSpec, source: { bytes: Buffer; mime: string }) =>
  params(spec).sourceEncoding === "base64"
    ? source.bytes.toString("base64")
    : `data:${source.mime};base64,${source.bytes.toString("base64")}`;

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
  const sizes = sizesOf(spec, request.op);
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
      prompt: promptField(op === "image_to_image" ? "改成什么样" : "画面描述", params(spec).promptLimit ?? 10_000),
      size: {
        type: "string",
        title: "尺寸",
        enum: sizesOf(spec, op),
        default: sizesOf(spec, op)[0],
        description:
          op === "image_to_image"
            ? `${AUTO} keeps the source image's frame, which is usually what an edit wants. An exact WIDTHxHEIGHT reframes the picture.`
            : "An exact WIDTHxHEIGHT fixes the frame. A tier such as 2K only sets a pixel budget and lets the backend choose the aspect, so the same prompt can come back in different shapes.",
      },
    };
    if (op === "image_to_image") {
      properties.source_image_id = {
        type: "string",
        title: "源图片",
        description: "Copy an exact image_id from the conversation.",
      };
      // Offered only by a model that composes. Advertising the slots on a
      // single-reference backend is how a prompt learns to send a field the
      // request then drops on the floor.
      const extras = maxSourcesOf(spec) - 1;
      if (extras > 0) {
        properties.additional_source_image_ids = {
          type: "array",
          title: `参考图（最多 ${extras} 张，按顺序作为参考）`,
          description: `Ordered references beyond the primary one. Refer to them in the prompt as [Image 2] onward.`,
          items: { type: "string" },
          maxItems: extras,
        };
      }
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
    // `auto` is not a value any backend takes; it is the absence of the field.
    const sized = size === AUTO ? {} : { size };
    const extra = params(spec).extra ?? {};
    const editExtra = params(spec).editExtra ?? {};
    ctx.progress(null, "已提交");

    const editing = request.op === "image_to_image";
    let response: Response;
    if (editing && unified(spec)) {
      const sources = request.sources;
      if (!sources.length) throw new GenerationError("This operation needs a source image", "invalid_request");
      // Told, not truncated: dropping the seventh reference silently produces a
      // picture the caller cannot tell is missing something.
      if (sources.length > maxSourcesOf(spec)) {
        throw new GenerationError(`${spec.name} accepts at most ${maxSourcesOf(spec)} images`, "invalid_request");
      }
      // One route, one JSON body, references in an array — the shape Seedream
      // and Ark use. A single reference still goes in the array; the field is
      // the same either way, so there is no second code path to keep in step.
      response = await http(`${base}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: spec.model,
          prompt: request.prompt,
          [params(spec).sourceField ?? "image"]: sources.map((source) => encode(spec, source)),
          ...sized,
          ...(params(spec).responseFormat ? { response_format: params(spec).responseFormat } : {}),
          ...extra,
          ...editExtra,
        }),
        cancel: ctx.signal,
        timeoutMs: TIMEOUT_MS,
        label: spec.name,
      });
    } else if (editing) {
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
          if (size !== AUTO) form.append("size", size);
          form.append("n", "1");
          for (const [key, value] of Object.entries({ ...extra, ...editExtra })) form.append(key, String(value));
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
    // `size` is not always a pair: Seedream takes resolution tiers like `2K` and
    // decides the aspect itself. Parsing those as WxH yielded NaN, which survived
    // `?? null` and reached the asset row, so the saved file is asked instead.
    const declared = /^\d+x\d+$/.test(size) ? size.split("x").map(Number) : [];
    const imageId = await saveImageBytes(ctx.store, bytes, {
      mime,
      provider: provider.id,
      model: spec.model,
      width: declared[0] ?? null,
      height: declared[1] ?? null,
      parents: request.sources.map((source) => source.imageId),
    });
    const asset = ctx.store.getImageAsset(imageId);
    return {
      assets: [
        { assetId: imageId, kind: "image", mime, width: asset?.width ?? null, height: asset?.height ?? null },
      ],
      effective: { size },
    };
  },
};

