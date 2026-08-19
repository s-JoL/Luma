import path from "node:path";
import type { Capabilities, PromptSettings } from "@shared/types.ts";
import { isChatKind, isMemoryKey } from "@shared/types.ts";
import { paths } from "./env.ts";
import type { SecretVault } from "./crypto/secrets.ts";
import type { Store } from "./store/store.ts";

export const SECRET = {
  provider: (id: string) => `provider:${id}`,
  /**
   * The web search key, whichever backend it belongs to. The slot id stays
   * `tavily` although the search layer is no longer Tavily-only: it is the row
   * name in `secrets`, so renaming it would strand every stored key, and the
   * settings route and the web UI both address it by that literal.
   */
  tavily: "tavily",
  embedding: "embedding",
  accessCode: "access-code",
  totp: "totp",
  /** Held until a first correct code proves the authenticator was enrolled. */
  totpPending: "totp-pending",
} as const;

/** Starting points, not a schema: the model may coin a key these do not cover. */
const SUGGESTED_MEMORY_KEYS = [
  "reference_library",
  "writing_preferences",
  "visual_preferences",
  "theme_preferences",
  "general_preferences",
  "personal_context",
  "active_projects",
];

/** Mirrors the librechat.yaml values that were actually in use. */
const DEFAULT_CAPABILITIES: Capabilities = {
  memory: {
    enabled: true,
    writeEnabled: true,
    suggestedKeys: SUGGESTED_MEMORY_KEYS,
    tokenLimit: 16000,
    // LibreChat's own documented default. Twice this is ~5,000 tokens for a
    // single entry, a third of the whole memory budget above.
    charLimit: 10000,
  },
  files: { enabled: true, searchEnabled: true, mode: "hybrid" },
  web: { enabled: true, provider: "tavily", hasTavilyKey: false },
  coding: { read: false, write: false, shell: false, workspace: "" },
  embedding: {
    enabled: true,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-embedding-8b",
    dimensions: null,
    // What the reference implementations of this splitter ship: LibreChat's
    // rag_api uses 1500/100 and its tuning guide recommends 1500/150, Open WebUI
    // documents 1500/200. The overlap is the number that decides whether an
    // answer straddling a boundary is retrievable at all, so it follows the
    // guide rather than the lowest of them.
    chunkSize: 1500,
    chunkOverlap: 150,
    hasKey: false,
  },
  studio: { enabled: true, servers: [] },
};

const DEFAULT_PROMPTS: PromptSettings = {
  globalPrompt: "",
  toolPrompt: "",
  titleModelId: "",
  titleEnabled: true,
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

/**
 * Every runtime knob the web UI can change. Reads go through the settings
 * table so a restart is never needed to pick up a change.
 */
export class Config {
  constructor(
    private readonly store: Store,
    private readonly vault: SecretVault,
  ) {}

  capabilities(): Capabilities {
    const stored = this.store.getSetting<Partial<Capabilities>>("capabilities", {});
    return {
      memory: { ...DEFAULT_CAPABILITIES.memory, ...stored.memory },
      files: { ...DEFAULT_CAPABILITIES.files, ...stored.files },
      web: {
        ...DEFAULT_CAPABILITIES.web,
        ...stored.web,
        hasTavilyKey: this.vault.has(SECRET.tavily),
      },
      coding: {
        ...DEFAULT_CAPABILITIES.coding,
        ...stored.coding,
        workspace: stored.coding?.workspace || path.resolve(paths.root, ".."),
      },
      embedding: {
        ...DEFAULT_CAPABILITIES.embedding,
        ...stored.embedding,
        hasKey: this.vault.has(SECRET.embedding),
      },
      studio: { ...DEFAULT_CAPABILITIES.studio, ...stored.studio },
    };
  }

  saveCapabilities(input: Partial<Capabilities>): Capabilities {
    const current = this.capabilities();
    const memory = { ...current.memory, ...input.memory };
    const files = { ...current.files, ...input.files };
    const web = { ...current.web, ...input.web };
    const coding = { ...current.coding, ...input.coding };
    const embedding = { ...current.embedding, ...input.embedding };
    const studio = { ...current.studio, ...input.studio };
    const chunkSize = clamp(embedding.chunkSize, 200, 8000, DEFAULT_CAPABILITIES.embedding.chunkSize);
    const next: Capabilities = {
      memory: {
        enabled: Boolean(memory.enabled),
        writeEnabled: Boolean(memory.writeEnabled),
        suggestedKeys: (Array.isArray(memory.suggestedKeys) ? memory.suggestedKeys : SUGGESTED_MEMORY_KEYS).filter(
          (key) => typeof key === "string" && isMemoryKey(key),
        ),
        tokenLimit: clamp(memory.tokenLimit, 256, 16000, 16000),
        charLimit: clamp(memory.charLimit, 1000, 10000, 10000),
      },
      files: {
        enabled: Boolean(files.enabled),
        searchEnabled: Boolean(files.searchEnabled),
        mode: files.mode === "keyword" || files.mode === "semantic" ? files.mode : "hybrid",
      },
      web: {
        enabled: Boolean(web.enabled),
        // Not validated against the adapter registry: the registry lives on the
        // server side of the tool layer, and an id it does not know falls back to
        // the default at call time rather than being refused here.
        provider: String(web.provider || DEFAULT_CAPABILITIES.web.provider),
        hasTavilyKey: current.web.hasTavilyKey,
      },
      coding: {
        read: Boolean(coding.read),
        write: Boolean(coding.write),
        shell: Boolean(coding.shell),
        workspace: String(coding.workspace || path.resolve(paths.root, "..")),
      },
      embedding: {
        enabled: Boolean(embedding.enabled),
        baseUrl: String(embedding.baseUrl || DEFAULT_CAPABILITIES.embedding.baseUrl).replace(/\/$/, ""),
        model: String(embedding.model || DEFAULT_CAPABILITIES.embedding.model),
        dimensions:
          embedding.dimensions == null || !Number.isFinite(Number(embedding.dimensions))
            ? null
            : clamp(embedding.dimensions, 64, 8192, 1024),
        chunkSize,
        // Past half the window consecutive chunks are mostly the same text, so
        // the extra embeddings buy nothing.
        chunkOverlap: clamp(
          embedding.chunkOverlap,
          0,
          Math.min(2000, Math.floor(chunkSize / 2)),
          DEFAULT_CAPABILITIES.embedding.chunkOverlap,
        ),
        hasKey: current.embedding.hasKey,
      },
      studio: {
        enabled: Boolean(studio.enabled),
        servers: (Array.isArray(studio.servers) ? studio.servers : []).filter(
          (id): id is string => typeof id === "string",
        ),
      },
    };
    if (!next.memory.suggestedKeys.length) next.memory.suggestedKeys = SUGGESTED_MEMORY_KEYS;
    this.store.setSetting("capabilities", next);
    return this.capabilities();
  }

  prompts(): PromptSettings {
    return { ...DEFAULT_PROMPTS, ...this.store.getSetting<Partial<PromptSettings>>("prompts", {}) };
  }

  savePrompts(input: Partial<PromptSettings>): PromptSettings {
    const current = this.prompts();
    const next: PromptSettings = {
      globalPrompt: typeof input.globalPrompt === "string" ? input.globalPrompt : current.globalPrompt,
      toolPrompt: typeof input.toolPrompt === "string" ? input.toolPrompt : current.toolPrompt,
      titleModelId: typeof input.titleModelId === "string" ? input.titleModelId : current.titleModelId,
      titleEnabled: input.titleEnabled == null ? current.titleEnabled : Boolean(input.titleEnabled),
    };
    this.store.setSetting("prompts", next);
    return next;
  }

  defaultModelId(): string {
    const stored = this.store.getSetting<string>("defaultModelId", "");
    if (stored && this.store.getModel(stored)?.enabled) return stored;
    return this.store.listModels().find((model) => model.enabled && isChatKind(model.kind))?.id ?? "";
  }

  setDefaultModelId(id: string) {
    this.store.setSetting("defaultModelId", id);
    return this.defaultModelId();
  }

  /**
   * Empty is a real answer: a deployment with no chosen default behaves exactly
   * as it did before profiles existed, however many profiles are stored. There
   * is deliberately no fall back to the first one — a profile gates
   * capabilities, so creating a "画图" preset would otherwise take the coding
   * tools away from every conversation that never asked for it.
   */
  defaultProfileId(): string {
    const stored = this.store.getSetting<string>("defaultProfileId", "");
    return stored && this.store.getProfile(stored) ? stored : "";
  }

  setDefaultProfileId(id: string) {
    this.store.setSetting("defaultProfileId", id);
    return this.defaultProfileId();
  }
}

export { DEFAULT_CAPABILITIES, DEFAULT_PROMPTS };
