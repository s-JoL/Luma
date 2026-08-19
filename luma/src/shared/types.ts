/**
 * Wire contract shared by the Luma server and every client (web today,
 * native later). Anything the browser is allowed to see lives here; secrets
 * never appear in these shapes.
 */

/**
 * The wire protocol a model is called with. Aggregators expose several of
 * these behind one base URL, so it belongs to the model rather than the
 * provider. Names follow how API gateways label their endpoints.
 */
export type ApiMode =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "openai-images"
  | "venice-image"
  | "comfy-workflow"
  | "openai-videos";

/**
 * What a model is for. `chat` models go through pi-ai; the generation kinds go
 * through a generation adapter named by `apiMode` (`08-generation.md`).
 */
export type ModelKind = "chat" | "image" | "video" | "embedding" | "rerank";

/** What goes in and what comes out. `image_to_image` is what "edit" means. */
export type GenerationOp = "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video";

export const API_MODES: Array<{ id: ApiMode; label: string; path: string; kinds: ModelKind[] }> = [
  { id: "openai-chat", label: "OpenAI Chat Completions", path: "/chat/completions", kinds: ["chat"] },
  { id: "openai-responses", label: "OpenAI Responses", path: "/responses", kinds: ["chat"] },
  { id: "anthropic-messages", label: "Anthropic Messages", path: "/messages", kinds: ["chat"] },
  { id: "openai-images", label: "OpenAI 图像（生成 / 编辑）", path: "/images/generations", kinds: ["image"] },
  { id: "venice-image", label: "Venice 图像（生成 / 编辑 / 多图）", path: "/image/generate", kinds: ["image"] },
  { id: "comfy-workflow", label: "本地 ComfyUI 工作流", path: "/prompt", kinds: ["image", "video"] },
  { id: "openai-videos", label: "OpenAI 兼容视频（异步）", path: "/videos", kinds: ["video"] },
];

/**
 * Whether a model of this api mode can only run once its provider has a key. A
 * ComfyUI on this machine is reached over plain HTTP with no credential, so
 * demanding one would mark a working local model as broken.
 */
export const needsApiKey = (apiMode: ApiMode) => apiMode !== "comfy-workflow";

/** Only chat models enter the pi-ai provider graph and the chat model switcher. */
export const isChatKind = (kind: ModelKind | undefined) => (kind ?? "chat") === "chat";

export const isGenerationKind = (kind: ModelKind | undefined) => kind === "image" || kind === "video";

/**
 * An operation in the words someone waiting on it would use. For the surfaces
 * where a person is making something — a queue card, a picture's provenance.
 * Settings deliberately shows the raw op instead, beside the raw model id and
 * api mode, because that is the vocabulary its reader is matching against a
 * schema and the docs.
 */
export const OP_LABELS: Record<GenerationOp, string> = {
  text_to_image: "文生图",
  image_to_image: "改图",
  text_to_video: "文生视频",
  image_to_video: "图生视频",
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type FileSearchMode = "keyword" | "semantic" | "hybrid";

export type EmbeddingStatus = "none" | "pending" | "ready" | "failed";

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

/**
 * How a provider presents its credential. `bearer` is what almost every
 * OpenAI-compatible endpoint wants; `header` covers the relay stations and
 * Azure-shaped gateways that read `x-api-key` or `api-key`, and `none` a
 * self-hosted Ollama, llama.cpp or vLLM that authenticates nobody.
 */
export type ProviderAuthStyle = "bearer" | "header" | "none";

export interface ProviderAuthConfig {
  style: ProviderAuthStyle;
  /** Header the key is written into when the style is `header`. */
  header?: string;
  /** Written in front of the key, e.g. `Bearer `. Empty by default. */
  prefix?: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** True when an API key is stored for this provider. The key itself never leaves the server. */
  hasKey: boolean;
  /** Absent resolves to `bearer`, so a row that never declared one is unchanged. */
  auth?: ProviderAuthConfig | null;
  enabled: boolean;
  sortOrder: number;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Omitted leaves the stored style as it is; null clears it back to `bearer`. */
  auth?: ProviderAuthConfig | null;
  enabled?: boolean;
}

export interface ModelSpec {
  id: string;
  name: string;
  providerId: string;
  model: string;
  enabled: boolean;
  /** Chat by default, so a row written before generation existed still loads. */
  kind: ModelKind;
  /** Operations a generation model offers; empty for chat. */
  ops: GenerationOp[];
  /** Adapter-specific declaration: sizes, workflow bindings, durations. */
  params?: Record<string, unknown> | null;
  /**
   * Shown in the chat model switcher. Every enabled model stays usable and
   * listed in settings; pinning is only about which few are one tap away.
   */
  pinned: boolean;
  /**
   * Generation only: offer this model to the agent as a tool of its own, beside
   * the profile's default one. Off by default because every tool's schema rides
   * along in each request, so a catalogue of near-identical drawing tools costs
   * tokens on every turn and leaves the model choosing between equivalents.
   */
  agentTool: boolean;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> | null;
  apiMode: ApiMode;
  /**
   * Sends the exact request body LibreChat sent: no `stream_options`, `store`,
   * token caps or cache keys, and text-only content flattened to a string.
   * Some gateways reject the full payload.
   */
  librechatCompat: boolean;
  systemPrompt?: string | null;
  temperature?: number | null;
  topP?: number | null;
  pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  compat?: Record<string, unknown> | null;
  sortOrder: number;
  /** Derived: provider has a usable API key. */
  configured?: boolean;
}

export type ModelInput = Omit<
  ModelSpec,
  "configured" | "sortOrder" | "librechatCompat" | "pinned" | "agentTool" | "kind" | "ops" | "params"
> & {
  sortOrder?: number;
  librechatCompat?: boolean;
  pinned?: boolean;
  agentTool?: boolean;
  kind?: ModelKind;
  ops?: GenerationOp[];
  params?: Record<string, unknown> | null;
};

/**
 * One entry of a provider's live catalogue, as offered for bulk adding. The
 * suggestion is a starting point read off the model id, never a verdict: no
 * regex over aggregator ids is right for every aggregator.
 */
export interface DiscoveredModel {
  model: string;
  /** True when a configured model already points at this remote id. */
  added: boolean;
  suggestion: {
    id: string;
    name: string;
    kind: ModelKind;
    ops: GenerationOp[];
    apiMode: ApiMode;
    reasoning: boolean;
    input: Array<"text" | "image">;
  };
}

/**
 * A memory key is an identifier, not a category. What a fact is *about* is a
 * judgement the model makes from the fact, so the server only checks that the
 * name is a name; a fixed vocabulary just meant filing everything under
 * `general_preferences` once the seven slots stopped fitting.
 */
export const isMemoryKey = (key: string) => /^[A-Za-z0-9_-]{1,64}$/.test(key);

export interface MemoryCapability {
  enabled: boolean;
  writeEnabled: boolean;
  /** Offered to the model and the client as reuse candidates, never enforced. */
  suggestedKeys: string[];
  tokenLimit: number;
  charLimit: number;
}

export interface FilesCapability {
  enabled: boolean;
  searchEnabled: boolean;
  mode: FileSearchMode;
}

export interface WebCapability {
  enabled: boolean;
  /**
   * Names the adapter in the search registry (`tools/web-search.ts`). A plain
   * string, not a union: a second backend is one registered object, and pinning
   * the union here would make adding it a change to the shared contract.
   */
  provider: string;
  hasTavilyKey: boolean;
}

export interface CodingCapability {
  read: boolean;
  write: boolean;
  shell: boolean;
  workspace: string;
}

export interface EmbeddingCapability {
  enabled: boolean;
  baseUrl: string;
  model: string;
  dimensions: number | null;
  chunkSize: number;
  chunkOverlap: number;
  hasKey: boolean;
}

export interface StudioCapability {
  enabled: boolean;
  /** MCP servers surfaced in the studio. Empty means every connected server. */
  servers: string[];
}

export interface Capabilities {
  memory: MemoryCapability;
  files: FilesCapability;
  web: WebCapability;
  coding: CodingCapability;
  embedding: EmbeddingCapability;
  studio: StudioCapability;
}

/**
 * One thing the studio can run: a generation model's operation, or a third-party
 * MCP tool. Generation entries carry `modelId` and `op`; MCP entries do not.
 */
export interface StudioTool {
  serverId: string;
  serverTitle: string;
  name: string;
  description: string;
  kind: "generate" | "edit" | "video" | "other";
  schema: JsonSchema;
  modelId?: string;
  op?: GenerationOp;
  /**
   * Whether this runs on our own GPU. Worth knowing before committing to a wait:
   * a local render is slow and free, a hosted one is quick and billed. Absent for
   * an MCP tool, whose backend this server cannot see.
   */
  local?: boolean;
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** A list's cap, stated machine-readably so a model need not read the title. */
  maxItems?: number;
  /**
   * Who the control is for. Absent, or `both`, means the model may set it and the
   * studio renders it. `studio` keeps it out of the tool the model is offered,
   * for a knob a model has no grounds to choose: a sampler its author already
   * tuned, or a seed only a person has a reason to pin. Omitting a parameter is
   * not the same as losing it — the adapter or the graph still carries a value.
   */
  audience?: "both" | "studio";
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
}

export interface StudioImage {
  id: string;
  mime: string;
  width: number | null;
  height: number | null;
  provider: string | null;
  model: string | null;
  name: string | null;
  parents: string[];
  createdAt: number;
}

export interface McpServer {
  id: string;
  title: string;
  enabled: boolean;
  /** Spawned over stdio. Empty for a remote server, which has a `url` instead. */
  command: string;
  /** A remote server reached over Streamable HTTP, or HTTP+SSE if it is older. */
  url?: string;
  args: string[];
  env: Record<string, string>;
  /** Sent on every remote request; the HTTP counterpart of `env`. */
  headers?: Record<string, string>;
  sortOrder: number;
}

export interface McpStatus {
  id: string;
  title: string;
  /** Whether the chat agent gets this server's tools. */
  enabled: boolean;
  connected: boolean;
  /** Connected for the studio only, and hidden from the agent. */
  studioOnly?: boolean;
  tools: string[];
  error?: string;
}

export interface PromptSettings {
  /** Always-on instructions prepended to every request. */
  globalPrompt: string;
  /** Domain instructions appended after the global prompt. */
  toolPrompt: string;
  /** Model used to name conversations; empty means reuse the conversation model. */
  titleModelId: string;
  titleEnabled: boolean;
}

/** The shipped prompt pair, so an edited prompt can be put back. */
export interface PromptDefaults {
  globalPrompt: string;
  toolPrompt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string;
  /** Empty means the default profile, so nothing has to be migrated. */
  profileId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  content: unknown;
  createdAt: number;
}

/** One matching message, with the conversation and place a client can open. */
export interface ConversationSearchHit {
  conversationId: string;
  title: string;
  seq: number;
  role: string;
  snippet: string;
  createdAt: number;
}

export interface RunSummary {
  id: string;
  conversationId: string;
  status: RunStatus;
  modelId: string;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * A destructive tool call held until a person decides. The model cannot create,
 * approve or skip one: it is written by the server's preflight and only the
 * decide endpoint moves it out of `pending`.
 */
export interface Approval {
  /** The tool call id, so a retried preflight finds the existing decision. */
  id: string;
  runId: string;
  conversationId: string;
  toolName: string;
  /** Why it is risky: `delete`, `delete_recursive`, `overwrite`, `move_overwrite`, `shell`. */
  action: string;
  /** One sentence naming exactly what will happen, shown on the approval card. */
  summary: string;
  /** Action-specific facts the card lists: paths, file counts, byte totals. */
  detail: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface StoredEvent {
  seq: number;
  runId: string;
  conversationId: string;
  type: string;
  data: unknown;
  createdAt: number;
}

export type FileKind = "all" | "docs" | "images";

/**
 * Where a file came from. Open-ended, because a future tool can invent its own;
 * clients label the ones they know and fall back to the raw value.
 */
export const FILE_SOURCE_LABELS: Record<string, string> = {
  upload: "上传",
  generated: "生成",
  note: "自建",
  librechat: "迁移",
};

export interface FileFacets {
  kinds: Record<FileKind, number>;
  sources: Array<{ id: string; count: number }>;
}

export interface FileLibrary {
  items: FileRecord[];
  total: number;
  facets: FileFacets;
}

export interface FileRecord {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  conversationId: string | null;
  source: string;
  embeddingStatus: EmbeddingStatus;
  embeddingError: string | null;
  chunkCount: number;
  pageCount: number | null;
  width: number | null;
  height: number | null;
  createdAt: number;
}

export interface MemoryRecord {
  key: string;
  value: string;
  tokens: number;
  updatedAt: number;
}

export interface ImageAsset {
  imageId: string;
  mime: string;
  width: number | null;
  height: number | null;
  provider: string | null;
  model: string | null;
  parentImageIds: string[];
  createdAt: number;
}

export interface VideoAsset {
  videoId: string;
  mime: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** A still a client can show before the bytes arrive, and what a follow-up question is about. */
  posterImageId: string | null;
  provider: string | null;
  model: string | null;
  parentImageIds: string[];
  createdAt: number;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * One asset a job produced, in the order the backend returned them. Everything
 * past `kind` is named exactly as `StudioImage` names it, so a client can render
 * a finished job with the renderer it already has for the gallery instead of
 * synthesising a tile with no filename and no provenance. `assetId` stays
 * alongside `id` because the tools and the transcript refer to assets by it.
 */
export interface GeneratedAsset {
  id: string;
  assetId: string;
  kind: "image" | "video";
  mime: string;
  width: number | null;
  height: number | null;
  name: string | null;
  provider: string | null;
  model: string | null;
  /** What this was derived from: read-only provenance for an edit or a frame. */
  parents: string[];
  createdAt: number;
  durationMs: number | null;
  /** A still to show before the bytes arrive; null for an image. */
  posterAssetId: string | null;
}

/**
 * One generation request. A job's whole state is this row, which is why there is
 * no job event log: a reconnecting client reads it and knows everything
 * (`08-generation.md §Jobs`).
 */
export interface JobRecord {
  id: string;
  kind: "image" | "video";
  op: GenerationOp;
  modelId: string;
  modelName: string;
  /** Null for studio work, which belongs to nobody's transcript. */
  conversationId: string | null;
  status: JobStatus;
  /** 0..1, or null when the backend reports no progress. */
  progress: number | null;
  note: string | null;
  params: Record<string, unknown>;
  /** Source asset ids for an edit or an image-to-video. */
  sources: string[];
  assets: GeneratedAsset[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface JobInput {
  modelId: string;
  op?: GenerationOp;
  conversationId?: string | null;
  params?: Record<string, unknown>;
  sources?: string[];
}

/**
 * Where one asset came from, assembled rather than stored: the asset row knows the
 * backend and the parents, and the job row knows the prompt and the parameters.
 * Neither is a new table, and asking the question this way means an image made
 * before the queue existed still answers with what is on record about it.
 */
export interface Provenance {
  assetId: string;
  kind: "image" | "video";
  mime: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  /** What it was made from: the source images of an edit, or a video's stills. */
  parents: string[];
  createdAt: number;
  /**
   * The request behind it, when there is one. Absent for an upload and for
   * anything generated before jobs were recorded, which is why every field above
   * stands on its own.
   */
  job?: {
    id: string;
    op: GenerationOp;
    modelId: string;
    modelName: string;
    /**
     * Whether the same request could be sent again — the model row still exists,
     * is enabled and still runs this operation. A button that would 404 is worse
     * than no button, and a deleted model is the ordinary way this goes false.
     */
    repeatable: boolean;
    params: Record<string, unknown>;
    sources: string[];
    /** Wall time the render took, when both ends were recorded. */
    elapsedMs: number | null;
  };
}

/** Which capabilities a profile offers. Their configuration stays deployment-wide. */
export interface ProfileCapabilities {
  memory: boolean;
  files: boolean;
  web: boolean;
  coding: boolean;
  skills: boolean;
  generation: boolean;
}

/**
 * The named bundle a conversation runs under: which models, which tools, which
 * MCP servers, which prompts. Choosing a model used to change the LLM and
 * nothing else.
 */
export interface Profile {
  id: string;
  name: string;
  chatModelId: string;
  imageModelId: string;
  /** Empty means edits go to `imageModelId` when it supports them. */
  editModelId: string;
  videoModelId: string;
  capabilities: ProfileCapabilities;
  /** MCP server ids. Empty means the deployment's own enabled set. */
  mcpServers: string[];
  /** Empty falls back to the deployment prompts. */
  globalPrompt: string;
  toolPrompt: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export type ProfileInput = Partial<Omit<Profile, "createdAt" | "updatedAt">> & { name: string };

export interface Bootstrap {
  version: string;
  models: ModelSpec[];
  providers: Provider[];
  defaultModelId: string;
  profiles: Profile[];
  defaultProfileId: string;
  capabilities: Capabilities;
  mcp: McpStatus[];
  prompts: PromptSettings;
  memoryKeys: string[];
  limits: { maxUploadBytes: number; maxAttachmentsPerMessage: number };
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
}

export interface SessionRecord {
  id: string;
  device: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
}

export interface SecuritySettings {
  totpEnabled: boolean;
  /** Whether this deployment is reached over TLS, as the server sees it. */
  overTls: boolean;
  trustProxy: boolean;
  sessions: SessionRecord[];
  currentSessionId: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
