/**
 * The generation registry: turns a model row into an adapter, a schema and a
 * runnable request. Everything that wants to make a picture — the studio, the
 * agent's tools, the job queue — comes through here, so one adapter describes a
 * backend once. The studio renders that schema whole; `forModel` narrows it to
 * the parameters the model is allowed to choose, and because the narrowing is a
 * function of the same schema, neither audience can learn about a knob the other
 * has never heard of.
 */
import fs from "node:fs";
import type { GenerationOp, JsonSchema, ModelSpec, Provider } from "@shared/types.ts";
import { stringifyToolEnums } from "../agent/tool-schema.ts";
import { SECRET } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import { assetPath } from "../images.ts";
import type { Store } from "../store/store.ts";
import { comfyAdapter } from "./comfy.ts";
import { openAiImagesAdapter } from "./openai-images.ts";
import { GenerationError, type GenerationAdapter, type SourceImage } from "./types.ts";
import { videoAdapter } from "./video.ts";
import { veniceVideoAdapter } from "./venice-video.ts";

const ADAPTERS = new Map<string, GenerationAdapter>(
  [openAiImagesAdapter, comfyAdapter, videoAdapter, veniceVideoAdapter].map((adapter) => [adapter.id, adapter]),
);

export const generationAdapter = (spec: ModelSpec) => ADAPTERS.get(spec.apiMode);

/** True when this row is something the generation layer can actually run. */
export function isRunnable(spec: ModelSpec) {
  return (spec.kind === "image" || spec.kind === "video") && ADAPTERS.has(spec.apiMode);
}

/**
 * Studio catalogue tie-breaker when no default backend is bound for this
 * kind: a keyed hosted backend, then local Comfy, then a hosted row that still
 * needs a key. The default generation slots outrank this in `/studio/tools`.
 */
export function studioPriority(spec: ModelSpec): number {
  if (spec.apiMode !== "comfy-workflow" && spec.configured !== false) return 0;
  if (spec.apiMode === "comfy-workflow") return 1;
  return 2;
}

const IMAGE_OPS: GenerationOp[] = ["text_to_image", "image_to_image"];
const VIDEO_OPS: GenerationOp[] = ["text_to_video", "image_to_video"];

/**
 * What a model row can actually be asked for: the intersection of what the row
 * claims, what its adapter implements, and what its kind allows. A row with no
 * ops falls back to the plain text-to-something case, which is what a bulk add
 * from a provider catalogue produces.
 */
export function opsOf(spec: ModelSpec): GenerationOp[] {
  return adapterOps(spec.apiMode, spec.kind, spec.ops);
}

export function adapterOps(apiMode: string, kind: string, asked: GenerationOp[] = []): GenerationOp[] {
  const adapter = ADAPTERS.get(apiMode);
  if (!adapter || (kind !== "image" && kind !== "video")) return [];
  const family = (kind === "video" ? VIDEO_OPS : IMAGE_OPS).filter((op) => adapter.runs.includes(op));
  const narrowed = asked.filter((op) => family.includes(op));
  return narrowed.length ? narrowed : family.slice(0, 1);
}

export function schemaOf(spec: ModelSpec, op: GenerationOp): JsonSchema {
  const adapter = generationAdapter(spec);
  if (!adapter) throw new GenerationError(`${spec.name} has no generation adapter`, "not_configured");
  return adapter.schema(spec, op);
}

/**
 * The one schema, narrowed to what the model is allowed to choose. Both audiences
 * are still described in one place — this only drops what an adapter marked as
 * the person's business, so the two can be compared rather than drifting apart.
 *
 * What is dropped is what a model cannot reason about: the sampler and step count
 * a workflow author already tuned, exact pixel dimensions that can contradict the
 * aspect ratio next to them, a seed whose previous value the model does not know.
 * None of it is lost, because an absent parameter falls back to the default the
 * adapter declared or the value already sitting in the graph.
 */
export function forModel(schema: JsonSchema): JsonSchema {
  const offered = Object.entries(schema.properties ?? {}).filter(([, field]) => field.audience !== "studio");
  const names = new Set(offered.map(([name]) => name));
  return stringifyToolEnums({
    ...schema,
    properties: Object.fromEntries(offered),
    required: (schema.required ?? []).filter((name) => names.has(name)),
  });
}

/** The first op a model offers, used when a caller does not name one. */
export function defaultOp(spec: ModelSpec): GenerationOp | undefined {
  const ops = opsOf(spec);
  return ops.find((op) => op === "text_to_image" || op === "text_to_video") ?? ops[0];
}

export const supportsOp = (spec: ModelSpec, op: GenerationOp) => opsOf(spec).includes(op);

const SOURCE_KEYS = ["source_image_id", "additional_source_image_ids", "image_ids"];

/** Source ids may arrive as named parameters or as an explicit list. */
export function sourceIdsFrom(params: Record<string, unknown>, explicit: string[] = []) {
  const ids = [...explicit];
  for (const key of SOURCE_KEYS) {
    const value = params[key];
    if (typeof value === "string") ids.push(value);
    if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") ids.push(entry);
  }
  const unique: string[] = [];
  for (const id of ids) {
    const normalised = id.trim().toLowerCase();
    if (/^img_[0-9a-f]{32}$/.test(normalised) && !unique.includes(normalised)) unique.push(normalised);
  }
  return unique;
}

/**
 * Reads source bytes once, here, so no adapter reimplements the asset lookup and
 * every adapter fails the same way on a bad id.
 */
export function resolveSources(store: Store, ids: string[]): SourceImage[] {
  return ids.map((imageId) => {
    const file = store.getFile(imageId);
    const diskPath = file?.diskPath ?? assetPath(imageId);
    if (!diskPath || !fs.existsSync(diskPath)) {
      throw new GenerationError(`No image with id ${imageId}`, "invalid_request");
    }
    const asset = store.getImageAsset(imageId);
    return {
      imageId,
      bytes: fs.readFileSync(diskPath),
      mime: file?.mime ?? asset?.mime ?? "image/png",
      width: file?.width ?? asset?.width ?? null,
      height: file?.height ?? asset?.height ?? null,
    };
  });
}

export function providerFor(store: Store, spec: ModelSpec): Provider {
  const provider = store.getProvider(spec.providerId);
  if (!provider) throw new GenerationError(`${spec.name} has no provider`, "not_configured");
  return provider;
}

export const apiKeyFor = (vault: SecretVault, spec: ModelSpec) => vault.get(SECRET.provider(spec.providerId)) ?? "";

export { GenerationError } from "./types.ts";
export type { GenerationRequest, GenerationResult, SourceImage } from "./types.ts";
