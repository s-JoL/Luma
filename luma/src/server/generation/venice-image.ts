/**
 * Venice's image API, which is OpenAI-shaped in spirit but not in detail: three
 * routes rather than two, aspect ratios rather than pixel sizes, and base64 in
 * the body for an edit. Carried over from the MCP sidecar, including the two
 * flags that matter — prompt enhancement stays off, because a backend rewriting
 * the prompt makes the Image Director SOP in the system prompt a lie.
 *
 * Multi-image edits go to a different route with a differently spelled model
 * field (`modelId`, not `model`), which is exactly the kind of detail that
 * argues for an adapter per provider instead of flags on one.
 */
import type { JsonSchema, ModelSpec } from "@shared/types.ts";
import { saveImageBytes } from "../images.ts";
import { request as http } from "./http.ts";
import {
  GenerationError,
  promptField,
  type GenerationAdapter,
  type GenerationContext,
  type GenerationRequest,
  type GenerationResult,
} from "./types.ts";

const TIMEOUT_MS = 180_000;
/**
 * Conservative defaults, not the vocabulary. Venice's own docs say sizing is
 * model-specific and to read the models endpoint before relying on a value, so
 * these are what a row that declares nothing gets — a row for a model with 4K
 * tiers or a wider ratio set says so, rather than the adapter guessing on its
 * behalf and turning an unsupported value into a 400 the user has to decode.
 */
const RATIOS = ["auto", "1:1", "3:2", "16:9", "9:16", "2:3", "3:4"];
const RESOLUTIONS = ["1K", "2K"];
const MAX_SOURCES = 6;

interface VeniceParams {
  ratios?: string[];
  resolutions?: string[];
  /** References this model accepts, primary included. */
  maxSources?: number;
  /** Model id for edits when it differs from the generation id. */
  editModel?: string;
  promptLimit?: number;
  /** Some Venice models reject the thinking flag; the row can turn it off. */
  disableOptimizeThinking?: boolean;
  /** Body fields only some models take, such as `quality` on gpt-image-2. */
  extra?: Record<string, unknown>;
}

const params = (spec: ModelSpec) => (spec.params ?? {}) as VeniceParams;
const ratiosOf = (spec: ModelSpec) => params(spec).ratios ?? RATIOS;
const resolutionsOf = (spec: ModelSpec) => params(spec).resolutions ?? RESOLUTIONS;
const maxSourcesOf = (spec: ModelSpec) => Math.max(1, params(spec).maxSources ?? MAX_SOURCES);

async function veniceImage(
  route: string,
  base: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const response = await http(`${base}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    cancel: signal,
    timeoutMs: TIMEOUT_MS,
    label: `Venice ${route}`,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GenerationError(`Venice ${route} returned ${response.status}: ${detail.slice(0, 300)}`, "upstream_error");
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const payload = (await response.json()) as { images?: string[]; data?: Array<{ b64_json?: string }> };
    const encoded = payload.images?.[0] ?? payload.data?.[0]?.b64_json;
    if (!encoded) throw new GenerationError("Venice returned no image", "upstream_error");
    return { bytes: Buffer.from(encoded, "base64"), mime: "image/png" };
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: type.split(";")[0] || "image/png",
  };
}

export const veniceImageAdapter: GenerationAdapter = {
  id: "venice-image",

  runs: ["text_to_image", "image_to_image"],

  schema(spec, op) {
    const properties: Record<string, JsonSchema> = {
      prompt: promptField(op === "image_to_image" ? "改成什么样" : "画面描述", params(spec).promptLimit ?? 10_000),
      aspect_ratio: { type: "string", title: "画幅", enum: ratiosOf(spec), default: "auto" },
      resolution: {
        type: "string",
        title: "分辨率",
        enum: resolutionsOf(spec),
        default: resolutionsOf(spec)[0] ?? "1K",
      },
    };
    if (op === "image_to_image") {
      properties.source_image_id = {
        type: "string",
        title: "源图片",
        description: "Copy an exact image_id from the conversation.",
      };
      // Derived from the cap the run actually enforces. Spelling the number
      // twice is how a title comes to promise five while the code allows six.
      const extras = maxSourcesOf(spec) - 1;
      if (extras > 0) {
        properties.additional_source_image_ids = {
          type: "array",
          title: `参考图（最多 ${extras} 张，按顺序作为图层或参考）`,
          items: { type: "string" },
          maxItems: extras,
        };
      }
    }
    // An edit without a base image is not a request anyone can answer, so the
    // schema says so rather than letting the backend reject it later.
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
    const ratio = String(request.params.aspect_ratio ?? "auto");
    const resolutions = resolutionsOf(spec);
    const resolution = resolutions.includes(String(request.params.resolution))
      ? String(request.params.resolution)
      : (resolutions[0] ?? "1K");
    ctx.progress(null, "已提交");

    const common: Record<string, unknown> = {
      prompt: request.prompt,
      resolution,
      enhance_prompt: false,
      safe_mode: false,
      ...(params(spec).disableOptimizeThinking === false ? {} : { disable_prompt_optimization_thinking: true }),
      // `auto` means "let the provider decide", which it does by omission.
      ...(ratio && ratio !== "auto" ? { aspect_ratio: ratio } : {}),
      ...(params(spec).extra ?? {}),
    };

    let output: { bytes: Buffer; mime: string };
    if (request.op === "image_to_image") {
      if (!request.sources.length) throw new GenerationError("This operation needs a source image", "invalid_request");
      if (request.sources.length > maxSourcesOf(spec)) {
        throw new GenerationError(`${spec.name} accepts at most ${maxSourcesOf(spec)} images`, "invalid_request");
      }
      const model = params(spec).editModel ?? spec.model;
      const encoded = request.sources.map((source) => source.bytes.toString("base64"));
      output =
        encoded.length > 1
          ? await veniceImage("/image/multi-edit", base, ctx.apiKey, { ...common, modelId: model, images: encoded }, ctx.signal)
          : await veniceImage("/image/edit", base, ctx.apiKey, { ...common, model, image: encoded[0] }, ctx.signal);
    } else {
      output = await veniceImage(
        "/image/generate",
        base,
        ctx.apiKey,
        { ...common, model: spec.model, format: "png", return_binary: false, variants: 1 },
        ctx.signal,
      );
    }

    const imageId = await saveImageBytes(ctx.store, output.bytes, {
      mime: output.mime,
      provider: provider.id,
      model: spec.model,
      parents: request.sources.map((source) => source.imageId),
    });
    const asset = ctx.store.getImageAsset(imageId);
    return {
      assets: [
        {
          assetId: imageId,
          kind: "image",
          mime: output.mime,
          width: asset?.width ?? null,
          height: asset?.height ?? null,
        },
      ],
      effective: { aspect_ratio: ratio, resolution },
    };
  },
};
