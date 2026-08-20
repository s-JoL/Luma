/**
 * A provider's live catalogue, classified into kinds.
 *
 * Two things went wrong with asking `GET {baseUrl}/models` once and believing
 * the answer. Some gateways keep their image models behind `?type=image`, so the
 * plain list is a hundred chat models and no way to add the drawing ones. And an
 * aggregator that does list image and video ids had nowhere to put them: every
 * one of CometAPI's 63 video ids came back suggested as a chat model.
 *
 * So the plain list is probed alongside the typed lists, and a typed list is
 * only believed when it actually differs from the plain one — an OpenAI-shaped
 * gateway ignores unknown query parameters and would otherwise hand back its
 * whole catalogue as "images".
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
  /image|flux|sdxl|stable-?diffusion|sd-?[\d.]+|dall-?e|imagen|midjourney|ideogram|recraft|playground-v|kolors|seedream|seededit|nano-?banana|hidream|lustify|boogu/i;
/** Takes an image *in*: editing for an image model, a first frame for a video one. */
const IMAGE_IN = /edit|kontext|inpaint|instruct|nano-?banana|gpt-image|i2v|image-?to-?video|kling|seedance|hailuo|wan/i;
const REASONING = /^o[1-9]|reason|think|-r1\b|qwq|opus-?4|sonnet-?4|sonnet-?3\.7|gemini-[\d.]+-pro|grok-4/i;
const VISION =
  /gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|opus-?4|sonnet-?4|haiku-?4|gemini|grok-4|llava|-vl|vision|pixtral|internvl|molmo|omni/i;

interface Classification {
  kind: ModelKind;
  reasoning: boolean;
  acceptsImage: boolean;
}

function read(model: string): Classification {
  const kind: ModelKind = VIDEO.test(model) ? "video" : IMAGE.test(model) ? "image" : "chat";
  return {
    kind,
    reasoning: kind === "chat" && REASONING.test(model),
    acceptsImage: kind === "chat" ? VISION.test(model) : IMAGE_IN.test(model),
  };
}

/**
 * Which wire protocol the endpoint speaks. Every hosted image API Luma speaks is
 * the OpenAI-shaped one, so only chat has anything worth reading: a suggestion
 * is a form the user reviews before saving, and the api mode is one of its
 * editable fields.
 *
 * Gemini is suggested on its own protocol rather than the OpenAI-compatible one
 * because `safetySettings` exists only there. Through the compatible endpoint
 * the field is accepted and ignored, and the model answers a perfectly ordinary
 * request with `finish_reason: content_filter` — a policy nobody in this
 * deployment chose. Same model, same gateway, one protocol that can be told not
 * to filter.
 */
function modeFor(kind: ModelKind, model: string, baseUrl: string): ApiMode {
  if (kind === "video") return "openai-videos";
  if (kind === "image") return "openai-images";
  if (/gemini/i.test(model)) return "google-generative";
  if (/anthropic\.com/i.test(baseUrl)) return "anthropic-messages";
  return "openai-chat";
}

/** Id → a name a person can read. Date suffixes like 260628 are dropped. */
function displayName(model: string) {
  const trimmed = model.replace(/[/]/g, " ").replace(/[-_]+/g, " ").replace(/\s+\d{6,}\b/g, "").trim();
  return trimmed.replace(/\b([a-z])/g, (letter) => letter.toUpperCase()) || model;
}

function opsFor(kind: ModelKind, acceptsImage: boolean): GenerationOp[] {
  if (kind === "image") return acceptsImage ? ["text_to_image", "image_to_image"] : ["text_to_image"];
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
  contextWindow?: number;
  maxTokens?: number;
}

function parseRow(row: Record<string, unknown>): RemoteRow | null {
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  const listed = typeof row.name === "string" ? row.name.trim() : "";
  return {
    id,
    name: listed && listed !== id ? listed : undefined,
    contextWindow: readNumber(row, [
      "context_length",
      "context_window",
      "max_model_len",
      "contextLength",
      "max_context_length",
    ]),
    maxTokens: readNumber(row, ["max_output_tokens", "maxOutputTokens", "max_tokens", "max_completion_tokens"]),
  };
}

function suggest(
  providerId: string,
  baseUrl: string,
  model: string,
  verdict: Classification,
  listed?: { name?: string; contextWindow?: number; maxTokens?: number },
) {
  const { kind, acceptsImage } = verdict;
  const guessed = guessLimits(model, kind);
  return {
    id: slug(`${providerId}-${model}`) || slug(model) || model,
    name: listed?.name || displayName(model),
    kind,
    ops: opsFor(kind, acceptsImage),
    apiMode: modeFor(kind, model, baseUrl),
    reasoning: kind === "chat" && verdict.reasoning,
    input: (kind === "chat" && acceptsImage ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
    contextWindow: listed?.contextWindow ?? guessed.contextWindow,
    maxTokens: listed?.maxTokens ?? guessed.maxTokens,
  };
}

async function listModels(baseUrl: string, key: string, query: string, signal?: AbortSignal): Promise<RemoteRow[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models${query}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`Provider returned ${response.status}`), { status: response.status });
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).map((item) => parseRow(item)).filter((row): row is RemoteRow => Boolean(row));
}

/** A typed list is only evidence when it is a proper subset of the plain one. */
async function typedIds(baseUrl: string, key: string, type: string, plain: Set<string>, signal?: AbortSignal) {
  try {
    const ids = (await listModels(baseUrl, key, `?type=${type}`, signal)).map((row) => row.id);
    if (!ids.length) return [];
    const novel = ids.filter((id) => !plain.has(id));
    if (!novel.length && ids.length >= plain.size) return [];
    return ids;
  } catch {
    // A provider without typed lists answers 400 or 404, which is not an error
    // for us: the plain list already told us everything it knows.
    return [];
  }
}

/** One id's suggestion, exposed for the tests. */
export const classifyModel = (model: string, providerId = "p", baseUrl = "") =>
  suggest(providerId, baseUrl, model, read(model));

export async function discoverModels(
  provider: Provider,
  key: string,
  configured: Set<string>,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const plain = await listModels(provider.baseUrl, key, "", signal);
  const byId = new Map(plain.map((row) => [row.id, row]));
  const plainSet = new Set(byId.keys());
  const [images, videos] = await Promise.all([
    typedIds(provider.baseUrl, key, "image", plainSet, signal),
    typedIds(provider.baseUrl, key, "video", plainSet, signal),
  ]);

  return [...new Set([...plainSet, ...images, ...videos])].sort().map((model) => {
    const guessed = read(model);
    // The provider saying "this is an image model" outranks anything read off
    // the name, so a typed list overrides the patterns rather than the other
    // way round.
    const kind: ModelKind = images.includes(model) ? "image" : videos.includes(model) ? "video" : guessed.kind;
    const listed = byId.get(model);
    return {
      model,
      added: configured.has(model),
      suggestion: suggest(provider.id, provider.baseUrl, model, { ...guessed, kind }, listed),
    };
  });
}
