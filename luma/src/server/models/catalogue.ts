/**
 * A provider's live catalogue, classified into kinds.
 *
 * Two things went wrong with asking `GET {baseUrl}/models` once and believing
 * the answer. Some gateways keep their image models behind `?type=image`, so the
 * plain list is a hundred chat models and no way to add the drawing ones. And an
 * aggregator that does list image and video ids had nowhere to put them: every
 * one of CometAPI's 63 video ids came back suggested as a chat model.
 *
 * So the plain list is probed alongside the typed lists (`image`, `video`,
 * `inpaint`), and a typed list is only believed when it actually differs from
 * the plain one — an OpenAI-shaped gateway ignores unknown query parameters and
 * would otherwise hand back its whole catalogue as "images".
 *
 * A listing that names its type (or its constraints) outranks a guess from the
 * id. The guess still fills in what the listing does not say, the same way a
 * chat row gets a context window when `/models` only returns an id.
 */
import type { ApiMode, DiscoveredModel, GenerationOp, ModelKind, Provider } from "@shared/types.ts";
import { slug } from "../ids.ts";

const TIMEOUT_MS = 20_000;

/**
 * Model families, read off the id.
 *
 * These are patterns and they will be wrong about something — a family shipped
 * after they were written comes back as a chat model. That is affordable here
 * and nowhere else: discovery produces a form the user reads before anything is
 * saved, every field of which is editable, so the cost of a bad guess is one
 * tap. Nothing in a conversation is decided this way.
 */
const VIDEO = /video|seedance|sora|veo|kling|runway|gen-?[34]|pika|hailuo|dream-?machine|ltx|mochi|cogvideo|vidu/i;
const IMAGE =
  /image|flux|sdxl|stable-?diffusion|sd-?[\d.]+|dall-?e|imagen|midjourney|ideogram|recraft|playground-v|kolors|seedream|seededit|nano-?banana|hidream|lustify|boogu|qwen-image|grok-imagine/i;
/** Takes an image *in*: editing for an image model, a first frame for a video one. */
const IMAGE_IN =
  /edit|kontext|inpaint|instruct|nano-?banana|gpt-image|seedream|seededit|qwen-image|hidream|grok-imagine|imagen|recraft|ideogram|i2v|image-?to-?video|kling|seedance|hailuo|wan/i;
const REASONING = /^o[1-9]|reason|think|-r1\b|qwq|opus-?4|sonnet-?4|sonnet-?3\.7|gemini-[\d.]+-pro|grok-4/i;
const VISION =
  /gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|opus-?4|sonnet-?4|haiku-?4|gemini|grok-4|llava|-vl|vision|pixtral|internvl|molmo|omni/i;
const SEEDREAM = /seedream/i;

const SEEDREAM_SIZES = [
  "2048x2048",
  "2736x1536",
  "1536x2736",
  "2368x1776",
  "1776x2368",
  "2496x1664",
  "1664x2496",
  "3136x1344",
  "2K",
  "1K",
];

interface Classification {
  kind: ModelKind;
  reasoning: boolean;
  acceptsImage: boolean;
  listed?: ListedHint;
}

/** What a live listing said about this id, when it said anything. */
export interface ListedHint {
  types?: string[];
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  constraints?: Record<string, unknown>;
}

function read(model: string, listed?: ListedHint): Classification {
  const types = new Set((listed?.types ?? []).map((type) => type.toLowerCase()));
  const kind: ModelKind = types.has("video")
    ? "video"
    : types.has("image") || types.has("inpaint")
      ? "image"
      : VIDEO.test(model)
        ? "video"
        : IMAGE.test(model)
          ? "image"
          : "chat";
  return {
    kind,
    reasoning: kind === "chat" && REASONING.test(model),
    acceptsImage: kind === "chat" ? VISION.test(model) : IMAGE_IN.test(model),
    listed,
  };
}

/**
 * Which wire protocol the endpoint speaks. Chat already reads the host
 * (Anthropic, Gemini). Generation does the same: a Venice image model is not
 * OpenAI's `/images/generations`, and calling that path is a 404 dressed up as
 * a failed render.
 */
function modeFor(kind: ModelKind, model: string, baseUrl: string): ApiMode {
  const venice = /venice\.ai/i.test(baseUrl);
  if (kind === "video") return venice ? "venice-videos" : "openai-videos";
  if (kind === "image") return venice ? "venice-images" : "openai-images";
  if (/gemini/i.test(model)) return "google-generative";
  if (/anthropic\.com/i.test(baseUrl)) return "anthropic-messages";
  return "openai-chat";
}

/** Id → a name a person can read. Date suffixes like 260628 are dropped. */
function displayName(model: string) {
  const trimmed = model.replace(/[/]/g, " ").replace(/[-_]+/g, " ").replace(/\s+\d{6,}\b/g, "").trim();
  return trimmed.replace(/\b([a-z])/g, (letter) => letter.toUpperCase()) || model;
}

/** Venice (and similar) ship generate and edit as two ids, usually `…-edit`. */
const EDIT_ID = /(?:^|[-_])(?:edit|inpaint)(?:[-_]|$)/i;

function opsFor(
  kind: ModelKind,
  model: string,
  apiMode: ApiMode,
  listed?: ListedHint,
  acceptsImage?: boolean,
): GenerationOp[] {
  const types = new Set((listed?.types ?? []).map((type) => type.toLowerCase()));
  if (kind === "image") {
    const generate = types.has("image");
    const edit = types.has("inpaint");
    // A host that speaks a split generate/edit protocol cannot take both ops
    // on one id. Guessing edit onto Seedream here is how a generate-only row
    // used to 404 on `/image/edit`.
    if (apiMode === "venice-images") {
      if (generate && edit) return ["text_to_image", "image_to_image"];
      if (edit && !generate) return ["image_to_image"];
      if (generate && !edit) return ["text_to_image"];
      return EDIT_ID.test(model) ? ["image_to_image"] : ["text_to_image"];
    }
    if (generate && edit) return ["text_to_image", "image_to_image"];
    if (edit && !generate) return ["image_to_image"];
    if (generate && !edit) {
      return acceptsImage || SEEDREAM.test(model) ? ["text_to_image", "image_to_image"] : ["text_to_image"];
    }
    return acceptsImage ? ["text_to_image", "image_to_image"] : ["text_to_image"];
  }
  if (kind === "video") return acceptsImage ? ["text_to_video", "image_to_video"] : ["text_to_video"];
  return [];
}

/**
 * Window and output cap. CometAPI's `/models` does not send either (id, owned_by,
 * created, that's it), so a family guess is what the bulk-add form has to start
 * from. A number on the listing wins when one is actually there.
 */
function guessLimits(model: string, kind: ModelKind = "chat"): { contextWindow: number; maxTokens: number } {
  if (kind !== "chat") return { contextWindow: 4096, maxTokens: 4096 };
  const id = model.toLowerCase();
  if (/gemini/.test(id)) return { contextWindow: 1_048_576, maxTokens: 65_536 };
  if (/claude/.test(id)) return { contextWindow: 1_000_000, maxTokens: 65_536 };
  if (/grok-4[.-]?[56]/.test(id)) return { contextWindow: 500_000, maxTokens: 65_536 };
  if (/grok/.test(id)) return { contextWindow: 256_000, maxTokens: 32_768 };
  if (/kimi/.test(id)) return { contextWindow: 256_000, maxTokens: 32_768 };
  if (/glm/.test(id)) return { contextWindow: 128_000, maxTokens: 32_768 };
  return { contextWindow: 128_000, maxTokens: 16_384 };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** Sizes, edit shape, prompt advice — the generation equivalent of a context-window guess. */
function familyParams(kind: ModelKind, model: string, apiMode: ApiMode, listed?: ListedHint): Record<string, unknown> | undefined {
  if (kind !== "image" && kind !== "video") return undefined;
  const params: Record<string, unknown> = {};
  const constraints = listed?.constraints ?? {};
  const ratios = asStringArray(constraints.aspectRatios).length
    ? asStringArray(constraints.aspectRatios)
    : asStringArray(constraints.aspect_ratios);
  const resolutions = asStringArray(constraints.resolutions);
  const qualities = asStringArray(constraints.qualities);
  const promptLimit =
    typeof constraints.promptCharacterLimit === "number"
      ? constraints.promptCharacterLimit
      : typeof constraints.prompt_character_limit === "number"
        ? constraints.prompt_character_limit
        : undefined;
  const maxSources =
    typeof constraints.maxInputImages === "number"
      ? constraints.maxInputImages
      : constraints.combineImages === true
        ? 3
        : undefined;
  if (ratios.length) params.aspectRatios = ratios;
  if (resolutions.length) params.resolutions = resolutions;
  if (qualities.length) params.qualities = qualities;
  if (promptLimit) params.promptLimit = promptLimit;
  if (kind === "image" && maxSources) params.maxSources = maxSources;

  if (kind === "image" && apiMode === "openai-images" && SEEDREAM.test(model)) {
    params.editMode = "unified";
    params.sourceField = "image";
    params.sourceEncoding = "data-uri";
    params.maxSources = 10;
    if (!params.sizes) params.sizes = SEEDREAM_SIZES;
    params.extra = { output_format: "png", watermark: false };
    params.promptHints =
      "Takes one dense natural-language paragraph, not tags. No weighting syntax. On an edit it keeps the source and applies the change asked for.";
  }

  return Object.keys(params).length ? params : undefined;
}

function readNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 1024) return Math.round(n);
  }
  const nested = row.architecture;
  if (nested && typeof nested === "object") return readNumber(nested as Record<string, unknown>, keys);
  return undefined;
}

interface RemoteRow {
  id: string;
  name?: string;
  types: string[];
  contextWindow?: number;
  maxTokens?: number;
  constraints?: Record<string, unknown>;
}

function parseRow(row: Record<string, unknown>, listedType?: string): RemoteRow | null {
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  const listed = typeof row.name === "string" ? row.name.trim() : "";
  const spec = row.model_spec && typeof row.model_spec === "object" ? (row.model_spec as Record<string, unknown>) : {};
  const type = typeof row.type === "string" ? row.type : listedType;
  const constraints =
    spec.constraints && typeof spec.constraints === "object" ? (spec.constraints as Record<string, unknown>) : undefined;
  return {
    id,
    name: listed && listed !== id ? listed : undefined,
    types: type && type !== "all" && type !== "text" ? [type] : [],
    contextWindow: readNumber(row, [
      "context_length",
      "context_window",
      "max_model_len",
      "contextLength",
      "max_context_length",
    ]),
    maxTokens: readNumber(row, ["max_output_tokens", "maxOutputTokens", "max_tokens", "max_completion_tokens"]),
    constraints,
  };
}

function suggest(
  providerId: string,
  baseUrl: string,
  model: string,
  verdict: Classification,
) {
  const { kind, acceptsImage, listed } = verdict;
  const guessed = guessLimits(model, kind);
  const apiMode = modeFor(kind, model, baseUrl);
  const ops = opsFor(kind, model, apiMode, listed, acceptsImage);
  return {
    id: slug(`${providerId}-${model}`) || slug(model) || model,
    name: listed?.name || displayName(model),
    kind,
    ops,
    apiMode,
    reasoning: kind === "chat" && verdict.reasoning,
    input: (kind === "chat" && acceptsImage ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
    contextWindow: listed?.contextWindow ?? guessed.contextWindow,
    maxTokens: listed?.maxTokens ?? guessed.maxTokens,
    params: familyParams(kind, model, apiMode, listed),
  };
}

async function listModels(
  baseUrl: string,
  key: string,
  query: string,
  signal?: AbortSignal,
): Promise<RemoteRow[]> {
  const listedType = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).get("type") ?? undefined;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models${query}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`Provider returned ${response.status}`), { status: response.status });
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>>; type?: string };
  const type = listedType || payload.type;
  return (payload.data ?? []).map((item) => parseRow(item, type)).filter((row): row is RemoteRow => Boolean(row));
}

/** A typed list is only evidence when it is a proper subset of the plain one. */
async function typedRows(
  baseUrl: string,
  key: string,
  type: string,
  plain: Set<string>,
  signal?: AbortSignal,
): Promise<RemoteRow[]> {
  try {
    const rows = await listModels(baseUrl, key, `?type=${type}`, signal);
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const novel = ids.filter((id) => !plain.has(id));
    if (!novel.length && ids.length >= plain.size) return [];
    return rows.map((row) => ({ ...row, types: row.types.length ? row.types : [type] }));
  } catch {
    // A provider without typed lists answers 400 or 404, which is not an error
    // for us: the plain list already told us everything it knows.
    return [];
  }
}

function merge(into: Map<string, RemoteRow>, rows: RemoteRow[]) {
  for (const row of rows) {
    const existing = into.get(row.id);
    if (!existing) {
      into.set(row.id, { ...row, types: [...row.types] });
      continue;
    }
    existing.types = [...new Set([...existing.types, ...row.types])];
    existing.name ??= row.name;
    existing.contextWindow ??= row.contextWindow;
    existing.maxTokens ??= row.maxTokens;
    existing.constraints ??= row.constraints;
  }
}

/** One id's suggestion, exposed for the tests. */
export const classifyModel = (model: string, providerId = "p", baseUrl = "", listed?: ListedHint) =>
  suggest(providerId, baseUrl, model, read(model, listed));

export async function discoverModels(
  provider: Provider,
  key: string,
  configured: Set<string>,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const plain = await listModels(provider.baseUrl, key, "", signal);
  const byId = new Map<string, RemoteRow>();
  merge(byId, plain);
  const plainSet = new Set(plain.map((row) => row.id));
  const typed = await Promise.all(
    ["image", "video", "inpaint"].map((type) => typedRows(provider.baseUrl, key, type, plainSet, signal)),
  );
  for (const rows of typed) merge(byId, rows);

  const items = [...byId.keys()].sort().map((model) => {
    const listed = byId.get(model);
    const hint: ListedHint | undefined = listed
      ? {
          types: listed.types,
          name: listed.name,
          contextWindow: listed.contextWindow,
          maxTokens: listed.maxTokens,
          constraints: listed.constraints,
        }
      : undefined;
    return {
      model,
      added: configured.has(model),
      suggestion: suggest(provider.id, provider.baseUrl, model, read(model, hint)),
    };
  });
  return linkEditSiblings(items);
}

/**
 * Hosts that split generate and edit (`foo` + `foo-edit`) still want one row
 * that can do both. The generate suggestion picks up the sibling id as
 * `editModel`; the edit row stays in the list for anyone who wants it alone.
 */
function linkEditSiblings(items: DiscoveredModel[]): DiscoveredModel[] {
  const index = new Map(items.map((item) => [item.model, item]));
  for (const item of items) {
    if (item.suggestion.kind !== "image") continue;
    const sibling = index.get(`${item.model}-edit`) ?? index.get(`${item.model}-inpaint`);
    if (!sibling || sibling.suggestion.kind !== "image") continue;
    if (!sibling.suggestion.ops.includes("image_to_image")) continue;
    const params: Record<string, unknown> = { ...(item.suggestion.params ?? {}), editModel: sibling.model };
    if (typeof sibling.suggestion.params?.maxSources === "number") {
      params.maxSources = sibling.suggestion.params.maxSources;
    }
    const ops = new Set<GenerationOp>(item.suggestion.ops);
    ops.add("image_to_image");
    item.suggestion.ops = [...ops];
    item.suggestion.params = params;
    sibling.coveredBy = item.model;
  }
  return items;
}
