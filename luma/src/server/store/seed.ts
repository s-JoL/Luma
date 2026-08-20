import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { API_MODES, type ModelInput, type ModelSpec, type ProviderInput } from "@shared/types.ts";
import { SECRET } from "../config.ts";
import type { Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import { paths } from "../env.ts";
import { DEFAULT_GLOBAL_PROMPT, DEFAULT_TOOL_PROMPT } from "../prompts/defaults.ts";
import { json } from "./db.ts";
import type { Store } from "./store.ts";

const SEED_VERSION = "15";

/**
 * Providers dropped from the defaults; removed on upgrade unless customised.
 * `venice` went with its adapter: its image API was the one hosted backend that
 * was not OpenAI-shaped, and carrying a second protocol for one provider cost
 * more than pointing an OpenAI-shaped row at whichever gateway serves the model.
 */
const RETIRED_PROVIDERS = ["kie"];

const PROVIDERS: Array<ProviderInput & { id: string }> = [
  { id: "cometapi", name: "CometAPI", baseUrl: "https://api.cometapi.com/v1" },
  { id: "comfy", name: "ComfyUI 本地", baseUrl: "http://127.0.0.1:8188" },
  { id: "venice", name: "Venice AI", baseUrl: "https://api.venice.ai/api/v1" },
];

const CHAT_ID = "cometapi:grok-4.6";
const IMAGE_ID = "comfy:lustify-v10";
const EDIT_ID = "cometapi:seedream-5-pro";
const COMET_VIDEO_ID = "cometapi:seedance-2-5";
const WAN_VIDEO_ID = "venice:wan-2-7";
const PREVIOUS_VIDEO_ID = "venice:seedance-2-5";
const VIDEO_ID = "venice:seedance-2-5-r2v";

/** Nothing that draws holds a conversation, so the chat-side fields are inert. */
const GENERATION_DEFAULTS = {
  enabled: true,
  pinned: false,
  reasoning: false,
  input: ["text"] as Array<"text" | "image">,
  contextWindow: 4096,
  maxTokens: 4096,
  thinkingLevel: "off" as const,
};

const MODELS: ModelInput[] = [
  {
    id: CHAT_ID,
    name: "Grok 4.6",
    providerId: "cometapi",
    model: "grok-4.6",
    enabled: true,
    pinned: true,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 500_000,
    maxTokens: 65_536,
    thinkingLevel: "high",
    apiMode: "openai-chat",
  },
  {
    ...GENERATION_DEFAULTS,
    id: IMAGE_ID,
    name: "Lustify v10",
    providerId: "comfy",
    model: "lustify-v10-krea-turbo",
    kind: "image",
    ops: ["text_to_image"],
    apiMode: "comfy-workflow",
    params: {
      workflow: "lustify-v10-krea-turbo.json",
      bind: {
        prompt: "4.inputs.text",
        width: "7.inputs.width",
        height: "7.inputs.height",
        seed: "8.inputs.seed",
      },
    },
  },
  {
    ...GENERATION_DEFAULTS,
    id: EDIT_ID,
    name: "Seedream 5 Pro",
    providerId: "cometapi",
    model: "seedream-5-0-pro-260628",
    kind: "image",
    ops: ["text_to_image", "image_to_image"],
    apiMode: "openai-images",
    params: {
      editMode: "unified",
      sourceField: "image",
      sourceEncoding: "data-uri",
      maxSources: 10,
      sizes: [
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
      ],
      extra: { output_format: "png", watermark: false },
      promptHints:
        "Takes one dense natural-language paragraph, not tags: it reads clauses and ownership (\"her left hand on his shoulder\") and loses meaning in comma-separated keyword lists. No weighting syntax, no quality slogans. It renders legible text when the exact words are quoted in the prompt. On an edit it keeps the source and applies the change asked for, and it accepts several reference images — say what each one contributes.",
    },
  },
  {
    ...GENERATION_DEFAULTS,
    id: COMET_VIDEO_ID,
    name: "Seedance 2.5",
    enabled: false,
    providerId: "cometapi",
    model: "seedance-2-5",
    kind: "video",
    ops: ["text_to_video", "image_to_video"],
    apiMode: "openai-videos",
    params: {
      submitFormat: "multipart",
      sourceField: "input_reference",
      maxSources: 1,
      durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
      sizes: [
        "1280x720",
        "720x1280",
        "960x960",
        "1112x834",
        "834x1112",
        "1470x630",
        "854x480",
        "480x854",
      ],
      promptHints:
        "Describes motion, not a still: what moves, in which direction, how fast, and what the camera does (hold, pan, push in, orbit, handheld). One continuous shot — asking for a cut, a montage or a second scene gets a confused single take. Given a first frame, describe only the movement away from it; the frame already carries the subject and the light.",
    },
  },
  {
    ...GENERATION_DEFAULTS,
    id: VIDEO_ID,
    name: "Seedance 2.5 R2V · Venice",
    providerId: "venice",
    model: "seedance-2-5-reference-to-video-basic",
    kind: "video",
    ops: ["image_to_video"],
    apiMode: "venice-videos",
    params: {
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
      resolutions: ["480p", "720p", "1080p"],
      aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      imageAspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      sourceField: "reference_image_urls",
      promptMax: 15_000,
      promptHints:
        "Describe one continuous shot: subject motion, direction and speed, then camera motion. With a first frame, describe only what changes after that frame.",
    },
  },
];

/**
 * MCP servers that shipped as defaults and no longer do. The five image sidecars
 * are gone because the generation layer runs the same ComfyUI graphs and the same
 * hosted image calls in process (`03-generation.md`); leaving them installed gave
 * the model two ways to draw and a coin flip between them.
 */
const RETIRED_MCP = [
  "local-image-generation",
  "venice-image-editing",
  "venice-generate",
  "venice-krea-generate",
  "local-edit",
];

/** Second names a provider's key has been seen under, beyond `${ID}_API_KEY`. */
const ENV_ALIASES: Record<string, string[]> = {
  cometapi: ["COMETAPI_KEY"],
  venice: ["VENICE_KEY"],
};

/**
 * Names of environment variables adopted once, on first boot only. Derived from
 * the provider list rather than written out again, so adding a provider above
 * is the whole edit and no id appears twice.
 */
const ENV_SECRETS: Array<[string, string[]]> = [
  ...PROVIDERS.map(
    (provider): [string, string[]] => [
      SECRET.provider(provider.id),
      [`${provider.id.toUpperCase().replaceAll("-", "_")}_API_KEY`, ...(ENV_ALIASES[provider.id] ?? [])],
    ],
  ),
  [SECRET.tavily, ["TAVILY_API_KEY"]],
  [SECRET.embedding, ["RAG_OPENAI_API_KEY", "EMBEDDING_API_KEY"]],
];

export function seed(store: Store, config: Config, vault: SecretVault) {
  installWorkflows(store);
  const previousVersion = store.getMeta("seed_version");
  if (previousVersion === SEED_VERSION) return false;
  for (const id of RETIRED_PROVIDERS) {
    if (store.getProvider(id)) store.deleteProvider(id);
  }
  // A row naming a protocol nothing implements any more is not a model the user
  // configured, it is a row whose adapter was removed under it. Its provider's
  // cascade covers the common case; this covers the row someone had pointed at
  // another gateway, which would otherwise sit in the list unable to run.
  const known = new Set(API_MODES.map((mode) => mode.id as string));
  for (const spec of store.listModels()) {
    if (!known.has(spec.apiMode)) store.deleteModel(spec.id);
  }
  retargetGemini(store);
  for (const id of RETIRED_MCP) store.deleteMcpServer(id);
  const adopted: string[] = [];
  for (const [index, provider] of PROVIDERS.entries()) {
    if (store.getProvider(provider.id)) continue;
    store.upsertProvider({ ...provider, enabled: true });
    store.db.run("UPDATE providers SET sort_order = ? WHERE id = ?", index, provider.id);
  }
  for (const [index, model] of MODELS.entries()) {
    const existing = store.getModel(model.id);
    if (!existing) {
      store.upsertModel({ ...model, sortOrder: index });
      continue;
    }
    // A shipped row that gained parameters has to reach the installs that
    // already have it, or a protocol fix only helps whoever installs next. The
    // same rule the workflow files use applies: adopt them only where there is
    // nothing to overwrite. A row with no parameters at all was never configured
    // by anyone, and one that has some is the user's.
    if (model.params && Object.keys(model.params).length && !Object.keys(existing.params ?? {}).length) {
      store.upsertModel({ ...existing, params: model.params });
      adopted.push(model.id);
    }
    // The first Comet chat rows all shipped with a generic 256k/32k pair because
    // `/v1/models` does not return a window. Replace that package with the
    // per-family numbers above, but not a window someone typed themselves.
    const current = store.getModel(model.id)!;
    if (
      current.contextWindow === 256_000 &&
      current.maxTokens === 32_768 &&
      (model.contextWindow !== 256_000 || model.maxTokens !== 32_768)
    ) {
      store.upsertModel({ ...current, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
      adopted.push(`${model.id}:window`);
    }
    const polished = polishShippedRow(store.getModel(model.id)!, model);
    if (polished) store.upsertModel(polished);
  }
  // v13 replaces the shipped Comet video binding with Venice. Do this once for
  // the untouched shipped row; a model the owner renamed is their configuration.
  if (previousVersion === "12") {
    const cometVideo = store.getModel(COMET_VIDEO_ID);
    if (cometVideo?.name === "Seedance 2.5") store.upsertModel({ ...cometVideo, enabled: false });
  }
  if (previousVersion === "13") store.deleteModel(WAN_VIDEO_ID);
  if (previousVersion === "14") store.deleteModel(PREVIOUS_VIDEO_ID);
  if (adopted.length) console.log(`[seed] adopted shipped parameters for ${adopted.join(", ")}`);
  applyShippedProfile(store, config);
  const prompts = config.prompts();
  config.savePrompts({
    globalPrompt: prompts.globalPrompt || DEFAULT_GLOBAL_PROMPT,
    toolPrompt: prompts.toolPrompt || DEFAULT_TOOL_PROMPT,
  });
  // The first seeded row is the default. Naming one here would make the list
  // below something the code depends on rather than data a user can replace.
  const first = MODELS[0];
  if (first && !store.getSetting<string>("defaultModelId", "")) config.setDefaultModelId(first.id);
  for (const [name, envNames] of ENV_SECRETS) {
    if (vault.has(name)) continue;
    const value = envNames.map((envName) => process.env[envName]).find((item) => item?.trim());
    if (value) vault.set(name, value);
  }
  store.setMeta("seed_version", SEED_VERSION);
  return true;
}

/** Earlier shipped chat defaults; still pointing at one of these means nobody picked a favourite. */
const PREVIOUS_CHAT_DEFAULTS = new Set([
  "grok-4.6",
  "claude-opus-4.6",
  "gemini-3.7-flash",
  "cometapi:claude-opus-4.6",
  "cometapi:gemini-3.7-flash",
  "cometapi:glm-5.3",
  "cometapi:kimi-k3",
]);

const STALE_SHIPPED_NAMES = new Set([
  "Grok 4.6 · CometAPI",
  "Lustify v10 · 本地",
  "Seedream 5 Pro · CometAPI",
  "Seedance 2.5 · CometAPI",
]);

/**
 * Moves Gemini rows onto Gemini's own protocol.
 *
 * Nobody chose the OpenAI-compatible one for them; it was simply the default
 * every bulk-added row got. The cost of leaving them there is not cosmetic: a
 * safety threshold can only be set on `generateContent`, so on the compatible
 * endpoint an ordinary request comes back as `finish_reason: content_filter`
 * and there is no field that can say otherwise. The rows are otherwise
 * untouched, and a row already on some other protocol deliberately — anything
 * that is not the default — is left where it is.
 */
function retargetGemini(store: Store) {
  const moved: string[] = [];
  for (const spec of store.listModels()) {
    if (spec.kind !== "chat" && spec.kind !== undefined) continue;
    if (spec.apiMode !== "openai-chat" || !/gemini/i.test(spec.model)) continue;
    store.upsertModel({ ...spec, apiMode: "google-generative" });
    moved.push(spec.id);
  }
  if (moved.length) console.log(`[seed] moved to Gemini's own protocol: ${moved.join(", ")}`);
}

function polishShippedRow(existing: ModelSpec, model: ModelInput) {
  const next = { ...existing };
  let changed = false;
  // Prompting advice about a backend is knowledge, not configuration: a row that
  // has none is a row that predates it, and filling in the absent key is how the
  // advice reaches an install whose parameters were otherwise already set. A key
  // that is present, empty included, is the user's answer and is left alone.
  const shippedHints = (model.params as { promptHints?: unknown } | undefined)?.promptHints;
  if (typeof shippedHints === "string" && !("promptHints" in (existing.params ?? {}))) {
    next.params = { ...(existing.params ?? {}), promptHints: shippedHints };
    changed = true;
  }
  if (model.enabled && !existing.enabled) {
    next.enabled = true;
    changed = true;
  }
  if (model.pinned && !existing.pinned) {
    next.pinned = true;
    changed = true;
  }
  if (STALE_SHIPPED_NAMES.has(existing.name) && model.name !== existing.name) {
    next.name = model.name;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * The shipped "通用" preset: chat, generate, edit, video. Existing installs keep
 * extra models they already added; only this named preset is retargeted, and only
 * while it is still called 通用.
 */
function applyShippedProfile(store: Store, config: Config) {
  const chat = store.getModel(CHAT_ID);
  const image = store.getModel(IMAGE_ID);
  const edit = store.getModel(EDIT_ID);
  const video = store.getModel(VIDEO_ID);

  if (!store.listProfiles().length) {
    if (!chat && !image) return;
    store.upsertProfile({
      id: "default",
      name: "通用",
      chatModelId: chat?.id ?? "",
      imageModelId: image?.id ?? "",
      editModelId: edit?.id ?? "",
      videoModelId: video?.id ?? "",
      capabilities: { memory: true, files: true, web: true, coding: true, skills: true, generation: true },
      mcpServers: [],
      sortOrder: 0,
    });
    config.setDefaultProfileId("default");
  } else {
    const id = config.defaultProfileId() || store.listProfiles()[0]?.id;
    const profile = id ? store.getProfile(id) : undefined;
    if (profile?.name === "通用") {
      store.upsertProfile({
        ...profile,
        chatModelId: chat?.id ?? profile.chatModelId,
        imageModelId: image?.id ?? profile.imageModelId,
        editModelId: edit?.id ?? profile.editModelId,
        videoModelId: video?.id ?? profile.videoModelId,
      });
    }
  }

  const current = store.getSetting<string>("defaultModelId", "");
  if (chat?.enabled && (!current || PREVIOUS_CHAT_DEFAULTS.has(current))) {
    config.setDefaultModelId(CHAT_ID);
  }
}

/** Hash of each shipped graph as this code last wrote it, by file name. */
const WORKFLOW_HASHES = "workflow_hashes";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Copies the shipped ComfyUI graphs into `data/workflows` and keeps them current
 * across upgrades. Installing them once was not enough: a graph revised in a new
 * build never reached an existing install, so a new parameter block only appeared
 * for whoever copied the files by hand.
 *
 * `data/` is still the user's. A file is replaced only while its bytes are the
 * ones recorded at install time; anything else — including a file that predates
 * the recording and so cannot be proven untouched — is an edit, and an edit is
 * kept and said out loud rather than silently overwritten.
 */
function installWorkflows(store: Store) {
  const source = path.join(paths.root, "workflows");
  if (!fs.existsSync(source)) return;
  const installed = json<Record<string, string>>(store.getMeta(WORKFLOW_HASHES), {});
  const kept: string[] = [];
  let recorded = false;
  for (const name of fs.readdirSync(source)) {
    if (!name.endsWith(".json")) continue;
    const target = path.join(paths.workflows, name);
    const shipped = fs.readFileSync(path.join(source, name));
    const hash = digest(shipped);
    const current = fs.existsSync(target) ? digest(fs.readFileSync(target)) : undefined;
    if (current !== hash) {
      if (current !== undefined && current !== installed[name]) {
        kept.push(name);
        continue;
      }
      fs.writeFileSync(target, shipped);
    }
    if (installed[name] !== hash) {
      installed[name] = hash;
      recorded = true;
    }
  }
  if (recorded) store.setMeta(WORKFLOW_HASHES, JSON.stringify(installed));
  if (kept.length) console.log(`[workflows] kept your edited ${kept.join(", ")}`);
}
