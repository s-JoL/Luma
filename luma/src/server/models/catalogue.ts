/**
 * A provider's live catalogue, classified into kinds.
 *
 * Two things went wrong with asking `GET {baseUrl}/models` once and believing
 * the answer. Venice keeps its image models behind `?type=image`, so its plain
 * list is 112 chat models and no way to add the drawing ones. And an aggregator
 * that does list image and video ids had nowhere to put them: every one of
 * CometAPI's 63 video ids came back suggested as a chat model.
 *
 * So the plain list is probed alongside the typed lists, and a typed list is
 * only believed when it actually differs from the plain one — an OpenAI-shaped
 * gateway ignores unknown query parameters and would otherwise hand back its
 * whole catalogue as "images".
 */
import type { ApiMode, DiscoveredModel, GenerationOp, ModelKind, Provider } from "@shared/types.ts";

const TIMEOUT_MS = 20_000;

const slug = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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
const REASONING = /^o[1-9]|reason|think|-r1\b|qwq|opus-?4|sonnet-?4|sonnet-?3\.7|gemini-[\d.]+-pro/i;
const VISION = /gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|opus-?4|sonnet-?4|haiku-?4|gemini|llava|-vl|vision|pixtral|internvl|molmo|omni/i;

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
 * Endpoints whose image API is not the OpenAI-shaped one. The common protocol
 * is the answer for everything else, so a line here only spares somebody one
 * dropdown on a form they are reading anyway — it is a hint, not a rule, and
 * removing it costs a suggestion rather than a capability.
 */
const IMAGE_MODE_HINTS: Array<[RegExp, ApiMode]> = [[/venice\.ai/i, "venice-image"]];

/**
 * Which wire protocol the endpoint speaks. This is a fact about the URL rather
 * than about the model, and no amount of reading the id can reveal it.
 */
function modeFor(kind: ModelKind, baseUrl: string): ApiMode {
  if (kind === "video") return "openai-videos";
  if (kind === "image") return IMAGE_MODE_HINTS.find(([host]) => host.test(baseUrl))?.[1] ?? "openai-images";
  return "openai-chat";
}

function opsFor(kind: ModelKind, acceptsImage: boolean): GenerationOp[] {
  if (kind === "image") return acceptsImage ? ["text_to_image", "image_to_image"] : ["text_to_image"];
  if (kind === "video") return acceptsImage ? ["text_to_video", "image_to_video"] : ["text_to_video"];
  return [];
}

function suggest(providerId: string, baseUrl: string, model: string, verdict: Classification) {
  const { kind, acceptsImage } = verdict;
  return {
    id: slug(`${providerId}-${model}`) || slug(model) || model,
    name: model,
    kind,
    ops: opsFor(kind, acceptsImage),
    apiMode: modeFor(kind, baseUrl),
    reasoning: kind === "chat" && verdict.reasoning,
    input: (kind === "chat" && acceptsImage ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
  };
}

async function listIds(baseUrl: string, key: string, query: string, signal?: AbortSignal) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models${query}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`Provider returned ${response.status}`), { status: response.status });
  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  return (payload.data ?? []).map((item) => String(item.id ?? "")).filter(Boolean);
}

/** A typed list is only evidence when it is a proper subset of the plain one. */
async function typedIds(baseUrl: string, key: string, type: string, plain: Set<string>, signal?: AbortSignal) {
  try {
    const ids = await listIds(baseUrl, key, `?type=${type}`, signal);
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
  const plain = await listIds(provider.baseUrl, key, "", signal);
  const plainSet = new Set(plain);
  const [images, videos] = await Promise.all([
    typedIds(provider.baseUrl, key, "image", plainSet, signal),
    typedIds(provider.baseUrl, key, "video", plainSet, signal),
  ]);

  return [...new Set([...plain, ...images, ...videos])].sort().map((model) => {
    const guessed = read(model);
    // The provider saying "this is an image model" outranks anything read off
    // the name, so a typed list overrides the patterns rather than the other
    // way round.
    const kind: ModelKind = images.includes(model) ? "image" : videos.includes(model) ? "video" : guessed.kind;
    return {
      model,
      added: configured.has(model),
      suggestion: suggest(provider.id, provider.baseUrl, model, { ...guessed, kind }),
    };
  });
}
