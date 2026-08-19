import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelInput, ProviderInput } from "@shared/types.ts";
import { SECRET } from "../config.ts";
import type { Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import { paths } from "../env.ts";
import { isRunnable, supportsOp } from "../generation/index.ts";
import { DEFAULT_GLOBAL_PROMPT, DEFAULT_TOOL_PROMPT } from "../prompts/defaults.ts";
import { json } from "./db.ts";
import type { Store } from "./store.ts";

const SEED_VERSION = "5";

/** Providers dropped from the defaults; removed on upgrade unless customised. */
const RETIRED_PROVIDERS = ["kie"];

const PROVIDERS: Array<ProviderInput & { id: string }> = [
  { id: "venice", name: "Venice", baseUrl: "https://api.venice.ai/api/v1" },
  { id: "cometapi", name: "CometAPI", baseUrl: "https://api.cometapi.com/v1" },
  // Local ComfyUI is a provider like any other; it just needs no key.
  { id: "comfy", name: "ComfyUI 本地", baseUrl: "http://127.0.0.1:8188" },
];

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
    id: "grok-4.6",
    name: "Grok 4.6 · Venice",
    providerId: "venice",
    model: "grok-4-6",
    enabled: true,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 500000,
    maxTokens: 65536,
    thinkingLevel: "high",
    apiMode: "openai-chat",
    librechatCompat: true,
    pricing: { input: 2.27, output: 6.8, cacheRead: 0.57 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: false,
      supportsStore: false,
      supportsStrictMode: true,
      sendSessionAffinityHeaders: false,
    },
  },
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6 · Venice",
    providerId: "venice",
    model: "claude-opus-4-6",
    enabled: true,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
    thinkingLevel: "high",
    apiMode: "openai-chat",
    pricing: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      sendSessionAffinityHeaders: true,
    },
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash · Venice",
    providerId: "venice",
    model: "gemini-3-7-flash",
    enabled: true,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
    thinkingLevel: "high",
    apiMode: "openai-chat",
    pricing: { input: 1.875, output: 9.375, cacheRead: 0.1875 },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      sendSessionAffinityHeaders: true,
    },
  },
  {
    id: "cometapi:claude-opus-4.6",
    name: "Claude Opus 4.6 · CometAPI",
    providerId: "cometapi",
    model: "claude-opus-4-6",
    enabled: true,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
    thinkingLevel: "high",
    apiMode: "anthropic-messages",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      sendSessionAffinityHeaders: false,
    },
  },
  // Both providers serve several of the same models, so every name carries its
  // provider: two entries called "Grok 4.6" in the switcher would be a coin flip.
  ...([
    { suffix: "grok-4.6", name: "Grok 4.6", model: "grok-4.6", reasoning: true },
    { suffix: "gemini-3.7-flash", name: "Gemini 3.7 Flash", model: "gemini-3.7-flash", reasoning: true },
    { suffix: "glm-5.3", name: "GLM 5.3", model: "glm-5.3", reasoning: true, input: ["text"] },
    { suffix: "kimi-k3", name: "Kimi K3", model: "kimi-k3", reasoning: true, input: ["text"] },
  ] as Array<{ suffix: string; name: string; model: string; reasoning: boolean; input?: Array<"text" | "image"> }>)
    .map((entry) => ({
      id: `cometapi:${entry.suffix}`,
      name: `${entry.name} · CometAPI`,
      providerId: "cometapi",
      model: entry.model,
      enabled: true,
      reasoning: entry.reasoning,
      input: entry.input ?? (["text", "image"] as Array<"text" | "image">),
      contextWindow: 256000,
      maxTokens: 32768,
      thinkingLevel: "high" as const,
      apiMode: "openai-chat" as const,
    })),
  // Generation models. `kind` is what keeps them out of the chat switcher and the
  // model graph, and what puts them in the studio and the agent's image tools.
  {
    ...GENERATION_DEFAULTS,
    id: "comfy:lustify-v10",
    name: "Lustify v10 · 本地",
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
    id: "comfy:boogu-edit",
    name: "Boogu Edit · 本地",
    providerId: "comfy",
    model: "boogu-edit-turbo",
    kind: "image",
    ops: ["image_to_image"],
    apiMode: "comfy-workflow",
    // Off by default: a local edit competes for the same VRAM as generation, and
    // the hosted editor below is the better first choice.
    enabled: false,
    params: {
      workflow: "boogu-edit-turbo.json",
      bind: {
        prompt: "8.inputs.prompt",
        source: "1.inputs.image",
        megapixels: "2.inputs.megapixels",
        seed: "12.inputs.noise_seed",
      },
      editMegapixels: 1,
    },
  },
  {
    ...GENERATION_DEFAULTS,
    id: "venice:seedream-v5-pro",
    name: "Seedream V5 Pro · Venice",
    providerId: "venice",
    model: "seedream-v5-pro",
    kind: "image",
    ops: ["text_to_image", "image_to_image"],
    apiMode: "venice-image",
    params: { editModel: "seedream-v5-pro-edit", promptLimit: 10000 },
  },
  {
    ...GENERATION_DEFAULTS,
    id: "cometapi:seedream-5-pro",
    name: "Seedream 5 Pro · CometAPI",
    providerId: "cometapi",
    model: "seedream-5-0-pro-260628",
    kind: "image",
    ops: ["text_to_image", "image_to_image"],
    apiMode: "openai-images",
    /**
     * Every value here was answered by the live API rather than read off a
     * documentation table, because the two disagree. `/images/edits` works but
     * takes one image; only the generations route with an `image` array composes
     * the ten references this model advertises, so that is the shape a row that
     * wants multi-reference editing has to ask for.
     *
     * The sizes are exact because a tier is a pixel budget, not a frame: `2K`
     * returned 2496x1664 for one call and 1776x2368 for the next from the same
     * prompt. On an edit the reference decides the aspect, which is what makes
     * `auto` the right default there and an explicit pair the right one here.
     */
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
      // The output arrived watermarked until this was sent explicitly, whatever
      // the route's documented default claims.
      extra: { output_format: "png", watermark: false },
    },
  },
  {
    ...GENERATION_DEFAULTS,
    id: "cometapi:seedance-2-5",
    name: "Seedance 2.5 · CometAPI",
    providerId: "cometapi",
    // `/v1/models` lists `seedance-2-5`. The documentation's
    // `seedance-2-5-260628` answers 503 model_not_found, so the live catalogue
    // wins over the table.
    model: "seedance-2-5",
    kind: "video",
    ops: ["text_to_video", "image_to_video"],
    apiMode: "openai-videos",
    params: {
      // Documented as multipart-only, and it carries reference frames as files
      // rather than as data URIs.
      submitFormat: "multipart",
      sourceField: "input_reference",
      maxSources: 1,
      durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
      // 2.5 serves 480p and 720p only; the exact pairs are the documented ones.
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
    },
  },
];

/**
 * MCP servers that shipped as defaults and no longer do. The five image sidecars
 * are gone because the generation layer runs the same ComfyUI graphs and the same
 * Venice calls in process (`08-generation.md`); leaving them installed gave the
 * model two ways to draw and a coin flip between them.
 */
const RETIRED_MCP = [
  "local-image-generation",
  "venice-image-editing",
  "venice-generate",
  "venice-krea-generate",
  "local-edit",
];

/** Second names a provider's key has been seen under, beyond `${ID}_API_KEY`. */
const ENV_ALIASES: Record<string, string[]> = { cometapi: ["COMETAPI_KEY"] };

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
  if (store.getMeta("seed_version") === SEED_VERSION) return false;
  for (const id of RETIRED_PROVIDERS) {
    if (store.getProvider(id)) store.deleteProvider(id);
  }
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
  }
  if (adopted.length) console.log(`[seed] adopted shipped parameters for ${adopted.join(", ")}`);
  seedDefaultProfile(store, config);
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

/**
 * One profile, naming which model is behind each of the agent's three generation
 * tools.
 *
 * Without it the tools are bound by falling back to the first enabled row, which
 * is `ORDER BY sort_order, name` — and two shipped rows share a sort order, so
 * which model the agent drew with came down to which name sorted first. That is
 * not a decision anyone made, and nothing in the interface showed what it had
 * landed on.
 *
 * So this pins what the fallback already resolves to rather than choosing
 * something new: behaviour is unchanged on the day it appears, and from then on
 * the binding is a row in Settings the user can read and change. Every capability
 * is on, because a profile that gated one would be a second, invisible place for
 * a feature to be switched off.
 */
function seedDefaultProfile(store: Store, config: Config) {
  if (store.listProfiles().length) return;
  const enabled = store.listModels().filter((spec) => spec.enabled);
  const chat = enabled.find((spec) => spec.kind === "chat");
  const image = enabled.find((spec) => spec.kind === "image" && isRunnable(spec));
  const video = enabled.find((spec) => spec.kind === "video" && isRunnable(spec));
  const edit =
    image && supportsOp(image, "image_to_image")
      ? image
      : enabled.find((spec) => spec.kind === "image" && isRunnable(spec) && supportsOp(spec, "image_to_image"));
  if (!chat && !image) return;

  store.upsertProfile({
    id: "default",
    name: "通用",
    chatModelId: chat?.id ?? "",
    imageModelId: image?.id ?? "",
    // Written out even when it equals the image model, so the settings row says
    // which model edits rather than leaving it to be inferred.
    editModelId: edit?.id ?? "",
    videoModelId: video?.id ?? "",
    capabilities: { memory: true, files: true, web: true, coding: true, skills: true, generation: true },
    mcpServers: [],
    sortOrder: 0,
  });
  config.setDefaultProfileId("default");
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
