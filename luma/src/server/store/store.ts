import { randomUUID } from "node:crypto";
import type {
  ApiMode,
  Approval,
  ApprovalStatus,
  EmbeddingStatus,
  FileFacets,
  FileKind,
  FileRecord,
  GeneratedAsset,
  GenerationOp,
  ImageAsset,
  JobInput,
  JobRecord,
  JobStatus,
  McpServer,
  MemoryRecord,
  ModelInput,
  ModelKind,
  ModelSpec,
  Profile,
  ProfileInput,
  Provider,
  ProviderAuthConfig,
  ProviderInput,
  RunStatus,
  RunSummary,
  SessionRecord,
  StoredEvent,
  StoredMessage,
  StudioImage,
  ThinkingLevel,
  VideoAsset,
} from "@shared/types.ts";
import { needsApiKey } from "@shared/types.ts";
import { providerAuth } from "../models/auth.ts";
import { bool, Db, json } from "./db.ts";

const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

/** Whether an existing approval row asks exactly what this call is asking. */
function sameQuestion(existing: Approval, input: Omit<Approval, "status" | "createdAt" | "updatedAt">) {
  return (
    existing.conversationId === input.conversationId &&
    existing.toolName === input.toolName &&
    existing.action === input.action &&
    existing.summary === input.summary &&
    JSON.stringify(existing.detail ?? {}) === JSON.stringify(input.detail ?? {})
  );
}

/**
 * Events worth broadcasting but not worth keeping. Text deltas are replayed from
 * the persisted transcript once a run settles, and a generation's progress is
 * superseded by its own job row — a ten-minute video would otherwise leave
 * hundreds of rows describing a percentage nobody can still be waiting for.
 */
const TRANSIENT_EVENTS = new Set(["message.delta", "job.progress"]);

export interface ChunkRow {
  id: string;
  fileId: string;
  idx: number;
  page: number | null;
  text: string;
}

/** A block of vectors as one row-major matrix: `chunkIds.length` rows of `dim`. */
export interface EmbeddingPage {
  chunkIds: string[];
  fileIds: string[];
  dim: number;
  data: Float32Array;
}

export interface FileQuery {
  kind?: FileKind;
  source?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

const filterByKind = (kind?: FileKind) =>
  kind === "images" ? "f.mime LIKE 'image/%'" : kind === "docs" ? "f.mime NOT LIKE 'image/%'" : "";

export class Store {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- settings

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? json<T>(row.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db.run(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      JSON.stringify(value),
      Date.now(),
    );
  }

  getMeta(key: string) {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.run(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  // ---------------------------------------------------------------- sessions

  createSession(tokenHash: string, device: string, ttlMs: number) {
    const now = Date.now();
    this.db.run(
      "INSERT INTO sessions(token_hash, device, created_at, last_seen, expires_at) VALUES(?, ?, ?, ?, ?)",
      tokenHash,
      device,
      now,
      now,
      now + ttlMs,
    );
    return now + ttlMs;
  }

  touchSession(tokenHash: string) {
    const now = Date.now();
    const row = this.db.get<{ expires_at: number }>(
      "SELECT expires_at FROM sessions WHERE token_hash = ?",
      tokenHash,
    );
    if (!row || row.expires_at < now) return false;
    this.db.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", now, tokenHash);
    return true;
  }

  deleteSession(tokenHash: string) {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /** The hash is the id: it identifies a session without being usable as one. */
  listSessions(): SessionRecord[] {
    return this.db
      .all("SELECT * FROM sessions WHERE expires_at > ? ORDER BY last_seen DESC", Date.now())
      .map((row) => ({
        id: String(row.token_hash),
        device: String(row.device),
        createdAt: Number(row.created_at),
        lastSeen: Number(row.last_seen),
        expiresAt: Number(row.expires_at),
      }));
  }

  /** Used when the access code is rotated: every device has to sign in again. */
  deleteAllSessions(except?: string) {
    this.db.run("DELETE FROM sessions WHERE token_hash <> ?", except ?? "");
  }

  purgeExpiredSessions() {
    this.db.run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
  }

  // --------------------------------------------------------------- providers

  listProviders(): Provider[] {
    return this.db
      .all("SELECT * FROM providers ORDER BY sort_order, name")
      .map((row) => this.toProvider(row));
  }

  getProvider(id: string): Provider | undefined {
    const row = this.db.get("SELECT * FROM providers WHERE id = ?", id);
    return row ? this.toProvider(row) : undefined;
  }

  private toProvider(row: Record<string, unknown>): Provider {
    const id = String(row.id);
    return {
      id,
      name: String(row.name),
      baseUrl: String(row.base_url),
      auth: json<ProviderAuthConfig | null>(row.auth, null),
      enabled: bool(row.enabled),
      sortOrder: Number(row.sort_order),
      hasKey: this.hasSecret(`provider:${id}`),
    };
  }

  upsertProvider(input: ProviderInput & { id: string }) {
    const now = Date.now();
    const existing = this.db.get<{ sort_order: number; auth: string | null }>(
      "SELECT sort_order, auth FROM providers WHERE id = ?",
      input.id,
    );
    const sortOrder = existing?.sort_order ?? this.nextSortOrder("providers");
    // An input that says nothing about the auth style keeps the stored one, so
    // renaming a provider through a caller that does not know about the field
    // cannot silently push a keyless endpoint back to bearer. Explicit null
    // clears it.
    const auth =
      input.auth === undefined ? (existing?.auth ?? null) : input.auth ? JSON.stringify(input.auth) : null;
    this.db.run(
      `INSERT INTO providers(id, name, base_url, auth, enabled, sort_order, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, base_url = excluded.base_url, auth = excluded.auth,
         enabled = excluded.enabled, updated_at = excluded.updated_at`,
      input.id,
      input.name,
      input.baseUrl.replace(/\/$/, ""),
      auth,
      input.enabled === false ? 0 : 1,
      sortOrder,
      now,
      now,
    );
    return this.getProvider(input.id)!;
  }

  deleteProvider(id: string) {
    this.db.run("DELETE FROM providers WHERE id = ?", id);
    this.deleteSecret(`provider:${id}`);
  }

  // ------------------------------------------------------------------ models

  listModels(): ModelSpec[] {
    const providers = new Map(this.listProviders().map((provider) => [provider.id, provider]));
    return this.db.all("SELECT * FROM models ORDER BY sort_order, name").map((row) => {
      const spec = toModelSpec(row);
      const provider = providers.get(spec.providerId);
      // A provider that declares no authentication has no key to be missing, so
      // its models are usable as soon as the row exists. Without this a keyless
      // local endpoint reports every chat model unconfigured and the switcher
      // filters them all out.
      spec.configured =
        !needsApiKey(spec.apiMode) ||
        (provider ? provider.hasKey || providerAuth(provider).style === "none" : false);
      return spec;
    });
  }

  getModel(id: string): ModelSpec | undefined {
    const row = this.db.get("SELECT * FROM models WHERE id = ?", id);
    return row ? toModelSpec(row) : undefined;
  }

  upsertModel(input: ModelInput) {
    const now = Date.now();
    const existing = this.db.get<{ sort_order: number }>(
      "SELECT sort_order FROM models WHERE id = ?",
      input.id,
    );
    const sortOrder = input.sortOrder ?? existing?.sort_order ?? this.nextSortOrder("models");
    this.db.run(
      `INSERT INTO models(id, provider_id, name, model, enabled, pinned, agent_tool, reasoning, input, context_window, max_tokens,
                          thinking_level, thinking_level_map, api_mode, kind, ops, params,
                          librechat_compat, system_prompt,
                          temperature, top_p, pricing, compat, sort_order, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_id = excluded.provider_id, name = excluded.name, model = excluded.model,
         enabled = excluded.enabled, pinned = excluded.pinned, agent_tool = excluded.agent_tool,
         reasoning = excluded.reasoning,
         input = excluded.input,
         context_window = excluded.context_window, max_tokens = excluded.max_tokens,
         thinking_level = excluded.thinking_level, thinking_level_map = excluded.thinking_level_map,
         api_mode = excluded.api_mode, kind = excluded.kind, ops = excluded.ops, params = excluded.params,
         librechat_compat = excluded.librechat_compat,
         system_prompt = excluded.system_prompt,
         temperature = excluded.temperature, top_p = excluded.top_p, pricing = excluded.pricing,
         compat = excluded.compat, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
      input.id,
      input.providerId,
      input.name,
      input.model,
      input.enabled === false ? 0 : 1,
      input.pinned === false ? 0 : 1,
      input.agentTool ? 1 : 0,
      input.reasoning ? 1 : 0,
      JSON.stringify(input.input ?? ["text"]),
      input.contextWindow,
      input.maxTokens,
      input.thinkingLevel ?? "off",
      input.thinkingLevelMap ? JSON.stringify(input.thinkingLevelMap) : null,
      input.apiMode ?? "openai-chat",
      input.kind ?? "chat",
      JSON.stringify(input.ops ?? []),
      input.params ? JSON.stringify(input.params) : null,
      input.librechatCompat ? 1 : 0,
      input.systemPrompt ?? null,
      input.temperature ?? null,
      input.topP ?? null,
      input.pricing ? JSON.stringify(input.pricing) : null,
      input.compat ? JSON.stringify(input.compat) : null,
      sortOrder,
      now,
      now,
    );
    return this.getModel(input.id)!;
  }

  deleteModel(id: string) {
    this.db.run("DELETE FROM models WHERE id = ?", id);
  }

  private nextSortOrder(table: "providers" | "models" | "mcp_servers" | "profiles") {
    const row = this.db.get<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${table}`,
    );
    return row?.next ?? 0;
  }

  // ------------------------------------------------------------- mcp servers

  listMcpServers(): McpServer[] {
    return this.db.all("SELECT * FROM mcp_servers ORDER BY sort_order, title").map((row) => ({
      id: String(row.id),
      title: String(row.title),
      enabled: bool(row.enabled),
      command: String(row.command),
      url: row.url == null ? undefined : String(row.url),
      args: json<string[]>(row.args, []),
      env: json<Record<string, string>>(row.env, {}),
      headers: json<Record<string, string> | undefined>(row.headers, undefined),
      sortOrder: Number(row.sort_order),
    }));
  }

  /**
   * A remote record needs no command, so one is optional here and stored as ''
   * rather than rejected — the transport picks itself from whichever of the two
   * the row carries.
   */
  upsertMcpServer(
    input: Omit<McpServer, "sortOrder" | "command"> & { command?: string; sortOrder?: number },
  ) {
    const now = Date.now();
    const existing = this.db.get<{ sort_order: number }>(
      "SELECT sort_order FROM mcp_servers WHERE id = ?",
      input.id,
    );
    const sortOrder = input.sortOrder ?? existing?.sort_order ?? this.nextSortOrder("mcp_servers");
    this.db.run(
      `INSERT INTO mcp_servers(id, title, enabled, command, url, args, env, headers, sort_order, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, enabled = excluded.enabled, command = excluded.command,
         url = excluded.url, args = excluded.args, env = excluded.env, headers = excluded.headers,
         sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
      input.id,
      input.title,
      input.enabled ? 1 : 0,
      input.command ?? "",
      input.url || null,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.env ?? {}),
      input.headers ? JSON.stringify(input.headers) : null,
      sortOrder,
      now,
      now,
    );
    return this.listMcpServers().find((server) => server.id === input.id)!;
  }

  deleteMcpServer(id: string) {
    this.db.run("DELETE FROM mcp_servers WHERE id = ?", id);
  }

  // ----------------------------------------------------------- conversations

  createConversation(modelId: string, title = "New conversation", profileId = "") {
    const id = newId("conv");
    const now = Date.now();
    this.db.run(
      "INSERT INTO conversations(id, title, model_id, profile_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      id,
      title,
      modelId,
      profileId,
      now,
      now,
    );
    return this.getConversation(id)!;
  }

  getConversation(id: string) {
    const row = this.db.get("SELECT * FROM conversations WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      title: String(row.title),
      modelId: String(row.model_id),
      profileId: String(row.profile_id ?? ""),
      archived: bool(row.archived),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  setConversationProfile(id: string, profileId: string) {
    this.db.run(
      "UPDATE conversations SET profile_id = ?, updated_at = ? WHERE id = ?",
      profileId,
      Date.now(),
      id,
    );
  }

  listConversations(limit: number, before?: number) {
    const rows = this.db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       WHERE c.archived = 0 AND (? IS NULL OR c.updated_at < ?)
       ORDER BY c.updated_at DESC LIMIT ?`,
      before ?? null,
      before ?? null,
      limit,
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      modelId: String(row.model_id),
      profileId: String(row.profile_id ?? ""),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      messageCount: Number(row.message_count),
    }));
  }

  setConversationTitle(id: string, title: string) {
    this.db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", title, Date.now(), id);
  }

  setConversationModel(id: string, modelId: string) {
    this.db.run("UPDATE conversations SET model_id = ?, updated_at = ? WHERE id = ?", modelId, Date.now(), id);
  }

  deleteConversation(id: string) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM events WHERE conversation_id = ?", id);
      this.db.run("DELETE FROM conversations WHERE id = ?", id);
    });
  }

  touchConversation(id: string) {
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", Date.now(), id);
  }

  // ---------------------------------------------------------------- messages

  /**
   * Projects one tree entry into the transcript clients read. `entryId` ties the
   * row back to the entry it came from, so a rewind can find the point in the
   * tree that a client sequence number refers to.
   */
  addMessage(conversationId: string, message: unknown, entryId?: string) {
    const id = newId("msg");
    const now = Date.now();
    const seq =
      (this.db.get<{ next: number }>(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?",
        conversationId,
      )?.next ?? 0);
    const role = (message as { role?: string } | null)?.role ?? "unknown";
    this.db.run(
      "INSERT INTO messages(id, conversation_id, seq, role, content, entry_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      id,
      conversationId,
      seq,
      role,
      JSON.stringify(message),
      entryId ?? null,
      now,
    );
    this.touchConversation(conversationId);
    return id;
  }

  /** Records which tree entry an already-projected row came from. */
  linkMessageEntry(messageId: string, entryId: string) {
    this.db.run("UPDATE messages SET entry_id = ? WHERE id = ?", entryId, messageId);
  }

  /**
   * Re-derives the whole transcript from the tree, renumbering sequences from
   * zero. Used after the branch moves, where rows do not merely get appended.
   * Clients refetch from scratch after a rewind, so the renumbering is safe.
   */
  replaceMessages(conversationId: string, rows: Array<{ message: unknown; entryId: string }>) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM messages WHERE conversation_id = ?", conversationId);
      const now = Date.now();
      rows.forEach((row, seq) => {
        this.db.run(
          "INSERT INTO messages(id, conversation_id, seq, role, content, entry_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
          newId("msg"),
          conversationId,
          seq,
          (row.message as { role?: string } | null)?.role ?? "unknown",
          JSON.stringify(row.message),
          row.entryId,
          now,
        );
      });
    });
    this.touchConversation(conversationId);
    return rows.length;
  }

  /** The tree entry a client sequence number was projected from, if any. */
  messageEntryId(conversationId: string, seq: number) {
    const row = this.db.get<{ entry_id: string | null }>(
      "SELECT entry_id FROM messages WHERE conversation_id = ? AND seq = ?",
      conversationId,
      seq,
    );
    return row?.entry_id ?? undefined;
  }

  /**
   * The projected rows for a set of tree entries, keyed by entry id.
   *
   * A search hits the tree, which holds abandoned branches and pre-compaction
   * history as well; an entry with no row here is one the reader cannot scroll
   * to, so it has nowhere to be shown.
   */
  messagesByEntryIds(entryIds: string[]): Map<string, StoredMessage> {
    const found = new Map<string, StoredMessage>();
    if (!entryIds.length) return found;
    const rows = this.db.all(
      `SELECT * FROM messages WHERE entry_id IN (${entryIds.map(() => "?").join(", ")})`,
      ...entryIds,
    );
    for (const row of rows) found.set(String(row.entry_id), toStoredMessage(row));
    return found;
  }

  /**
   * Newest transcript rows containing `text`, for the queries the tree's trigram
   * index cannot answer: it has no token shorter than three characters, and two
   * characters is a whole word in Chinese. Scans the projection rather than the
   * tree, so only what a reader can scroll to is ever returned.
   */
  messagesContaining(text: string, roles: string[], limit: number): StoredMessage[] {
    if (!text) return [];
    return this.db
      .all(
        `SELECT * FROM messages
         WHERE role IN (${roles.map(() => "?").join(", ")}) AND instr(lower(content), lower(?)) > 0
         ORDER BY created_at DESC, seq DESC LIMIT ?`,
        ...roles,
        text,
        Math.max(1, limit),
      )
      .map(toStoredMessage);
  }

  /** Raw AgentMessage transcript, ready to hand back to the agent loop. */
  messages(conversationId: string): unknown[] {
    return this.db
      .all("SELECT content FROM messages WHERE conversation_id = ? ORDER BY seq", conversationId)
      .map((row) => json<unknown>(row.content, null));
  }

  /**
   * `afterSeq` lets a client top up its transcript instead of refetching it.
   * Sequences start at 0, so the default has to sit below the first message.
   */
  storedMessages(conversationId: string, afterSeq = -1): StoredMessage[] {
    return this.db
      .all(
        "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq",
        conversationId,
        afterSeq,
      )
      .map(toStoredMessage);
  }

  /**
   * The newest page of a transcript, oldest-first, for a client opening a long
   * conversation. `storedMessages` answers "what is new"; this answers "what do
   * I show first", which for a year-old conversation is not the whole thing.
   *
   * A page is extended backwards to the user message that starts the turn it
   * lands in. Without that a page can open on a tool result whose call is on
   * the previous page, which renders as an orphan block; the extension is
   * bounded so a single enormous turn cannot drag the whole transcript in.
   */
  messagePage(conversationId: string, before: number | null, limit: number) {
    const size = Math.max(1, Math.min(limit, 500));
    const rows = this.db.all(
      "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
      size,
    );
    const items = rows.reverse().map(toStoredMessage);

    if (items.length === size) {
      const budget = size;
      for (let taken = 0; taken < budget && items[0] && items[0].role !== "user"; taken += 1) {
        const previous = this.db.get(
          "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1",
          conversationId,
          items[0].seq,
        );
        if (!previous) break;
        items.unshift(toStoredMessage(previous));
      }
    }

    const earliest = items[0]?.seq;
    const more =
      earliest === undefined
        ? false
        : Number(
            this.db.get(
              "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND seq < ?",
              conversationId,
              earliest,
            )?.count ?? 0,
          ) > 0;
    return { items, nextCursor: more ? earliest! : null };
  }

  /**
   * Drops a message and everything after it. Editing or regenerating a turn
   * rewrites history from that point, and the transcript is the agent's only
   * memory, so the abandoned branch has to go rather than linger unseen. New
   * messages then take the freed sequence numbers, which keeps the client's
   * incremental fetch honest: it refetches from scratch after a rewind.
   */
  truncateMessages(conversationId: string, fromSeq: number) {
    const removed = Number(
      this.db.run("DELETE FROM messages WHERE conversation_id = ? AND seq >= ?", conversationId, fromSeq).changes,
    );
    if (removed) this.touchConversation(conversationId);
    return removed;
  }

  messageCount(conversationId: string) {
    return (
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        conversationId,
      )?.count ?? 0
    );
  }

  // -------------------------------------------------------------------- runs

  createRun(conversationId: string, modelId: string): RunSummary {
    const id = newId("run");
    const now = Date.now();
    this.db.run(
      "INSERT INTO runs(id, conversation_id, status, model_id, created_at, updated_at) VALUES(?, ?, 'queued', ?, ?, ?)",
      id,
      conversationId,
      modelId,
      now,
      now,
    );
    return this.getRun(id)!;
  }

  getRun(id: string): RunSummary | undefined {
    const row = this.db.get("SELECT * FROM runs WHERE id = ?", id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      status: String(row.status) as RunStatus,
      modelId: String(row.model_id),
      error: (row.error as string | null) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  setRunStatus(id: string, status: RunStatus, error?: string) {
    this.db.run(
      "UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
      status,
      error ?? null,
      Date.now(),
      id,
    );
  }

  activeRun(conversationId: string) {
    const row = this.db.get(
      "SELECT * FROM runs WHERE conversation_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      conversationId,
    );
    return row ? this.getRun(String(row.id)) : undefined;
  }

  /**
   * Every image the app knows about, newest first. Generated images are adopted
   * into `files` on arrival, so the library and the gallery read one table and
   * cannot disagree; `image_assets` only adds provenance.
   */
  listImages(limit: number, offset: number): StudioImage[] {
    return this.db
      .all(
        `SELECT f.id AS id, f.mime AS mime, f.width AS width, f.height AS height,
                COALESCE(a.provider, f.source) AS provider, a.model AS model, f.name AS name,
                COALESCE(a.parent_image_ids, '[]') AS parents, f.created_at AS created_at
           FROM files f LEFT JOIN image_assets a ON a.image_id = f.id
          WHERE f.mime LIKE 'image/%'
          ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?`,
        limit,
        offset,
      )
      .map((row) => ({
        id: String(row.id),
        mime: String(row.mime),
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        provider: (row.provider as string | null) ?? null,
        model: (row.model as string | null) ?? null,
        name: (row.name as string | null) ?? null,
        parents: json<string[]>(row.parents, []),
        createdAt: Number(row.created_at),
      }));
  }

  /**
   * Migrated conversations can reference images whose bytes never made it
   * across. They cannot be shown or edited, so they are dropped rather than
   * left to render as broken tiles in the gallery.
   */
  pruneMissingImageAssets(exists: (imageId: string) => boolean) {
    const orphans = this.db
      .all("SELECT image_id FROM image_assets WHERE image_id NOT IN (SELECT id FROM files)")
      .map((row) => String(row.image_id))
      .filter((id) => !exists(id));
    for (const id of orphans) this.db.run("DELETE FROM image_assets WHERE image_id = ?", id);
    return orphans.length;
  }

  countImages() {
    const row = this.db.get<{ total: number }>(
      "SELECT COUNT(*) AS total FROM files WHERE mime LIKE 'image/%'",
    );
    return Number(row?.total ?? 0);
  }

  /** Assets whose bytes exist but that never got a library row. */
  unadoptedImageAssets(): ImageAsset[] {
    return this.db
      .all("SELECT * FROM image_assets WHERE image_id NOT IN (SELECT id FROM files)")
      .map(toImageAsset);
  }

  /** Seq of the newest event whose message is already in the transcript. */
  lastPersistedEventSeq(runId: string) {
    const row = this.db.get<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM events WHERE run_id = ? AND type = 'message.end'",
      runId,
    );
    return Number(row?.seq ?? 0);
  }

  /** Marks runs left behind by a crash so the UI never shows a phantom spinner. */
  failStaleRuns() {
    this.db.run(
      "UPDATE runs SET status = 'failed', error = 'Server restarted while the run was active', updated_at = ? WHERE status IN ('queued','running')",
      Date.now(),
    );
  }

  // --------------------------------------------------------------- approvals

  /**
   * Records a destructive tool call as awaiting a decision, or returns the row
   * that already exists for this tool call. Re-entering the gate — a resumed
   * run, a duplicated preflight — must never ask a second time or, worse,
   * reset a decision that was already made.
   *
   * The caller's id is a provider's tool-call id, and that is not the unique
   * handle it looks like: an OpenAI-compatible backend that omits the field
   * leaves it empty, and several restart the numbering on every response. A row
   * is therefore reused only when it is the same question — same conversation,
   * same tool, same classified action, same detail. Anything else opens a new
   * one, so an answer given about `npm test` can never authorise a command
   * nobody read.
   */
  requestApproval(input: Omit<Approval, "status" | "createdAt" | "updatedAt">): Approval {
    const existing = input.id ? this.getApproval(input.id) : undefined;
    if (existing && sameQuestion(existing, input)) return existing;
    const id = input.id && !existing ? input.id : newId("apr");
    const now = Date.now();
    this.db.run(
      "INSERT INTO approvals(id, run_id, conversation_id, tool_name, action, summary, detail, status, created_at, updated_at)" +
        " VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id,
      input.runId,
      input.conversationId,
      input.toolName,
      input.action,
      input.summary,
      JSON.stringify(input.detail ?? {}),
      now,
      now,
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.get("SELECT * FROM approvals WHERE id = ?", id);
    return row ? toApproval(row) : undefined;
  }

  /**
   * Moves a pending approval to its decision. Returns undefined when the row is
   * already settled, which is what makes a double-tap on the approve button and
   * a retried request harmless.
   */
  decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">): Approval | undefined {
    const result = this.db.run(
      "UPDATE approvals SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      status,
      Date.now(),
      id,
    );
    return Number(result.changes) ? this.getApproval(id) : undefined;
  }

  pendingApprovals(conversationId?: string): Approval[] {
    const rows = conversationId
      ? this.db.all(
          "SELECT * FROM approvals WHERE status = 'pending' AND conversation_id = ? ORDER BY created_at",
          conversationId,
        )
      : this.db.all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at");
    return rows.map(toApproval);
  }

  conversationApprovals(conversationId: string, limit = 100): Approval[] {
    return this.db
      .all(
        "SELECT * FROM approvals WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
        conversationId,
        limit,
      )
      .map(toApproval);
  }

  /**
   * A pending approval whose run died with the process can never be answered:
   * the tool call that was waiting for it no longer exists. Expiring them at
   * startup keeps the UI from offering a button that decides nothing.
   */
  expireOrphanApprovals() {
    const result = this.db.run(
      "UPDATE approvals SET status = 'expired', updated_at = ?" +
        " WHERE status = 'pending' AND run_id NOT IN (SELECT id FROM runs WHERE status IN ('queued','running'))",
      Date.now(),
    );
    return Number(result.changes);
  }

  // ------------------------------------------------------------------ events

  addEvent(runId: string, conversationId: string, type: string, data: unknown) {
    const now = Date.now();
    const result = this.db.run(
      "INSERT INTO events(run_id, conversation_id, type, data, created_at) VALUES(?, ?, ?, ?, ?)",
      runId,
      conversationId,
      type,
      JSON.stringify(data ?? {}),
      now,
    );
    return {
      seq: Number(result.lastInsertRowid),
      runId,
      conversationId,
      type,
      data,
      createdAt: now,
    } satisfies StoredEvent;
  }

  eventsSince(runId: string, afterSeq: number): StoredEvent[] {
    return this.db
      .all("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq", runId, afterSeq)
      .map(toEvent);
  }

  conversationEventsSince(conversationId: string, afterSeq: number, limit = 500): StoredEvent[] {
    return this.db
      .all(
        "SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        conversationId,
        afterSeq,
        limit,
      )
      .map(toEvent);
  }

  /**
   * Drops replayable deltas from runs that settled long enough ago that no
   * client can still be catching up; terminal events survive. A polling client
   * reads in bursts, so deleting a run's deltas the instant it finishes can
   * erase text the client never received.
   */
  pruneSettledTransientEvents(olderThanMs: number) {
    this.db.run(
      `DELETE FROM events
       WHERE type IN (${[...TRANSIENT_EVENTS].map(() => "?").join(",")})
         AND run_id IN (
           SELECT id FROM runs WHERE status IN ('completed','failed','cancelled') AND updated_at < ?
         )`,
      ...TRANSIENT_EVENTS,
      Date.now() - olderThanMs,
    );
  }

  /** Hands the pages freed above back to the filesystem. */
  reclaimStorage() {
    return this.db.reclaim();
  }

  // ---------------------------------------------------------------- memories

  listMemories(): MemoryRecord[] {
    return this.db.all("SELECT * FROM memories ORDER BY updated_at").map((row) => ({
      key: String(row.key),
      value: String(row.value),
      tokens: Number(row.tokens),
      updatedAt: Number(row.updated_at),
    }));
  }

  getMemory(key: string): MemoryRecord | undefined {
    const row = this.db.get("SELECT * FROM memories WHERE key = ?", key);
    if (!row) return undefined;
    return {
      key: String(row.key),
      value: String(row.value),
      tokens: Number(row.tokens),
      updatedAt: Number(row.updated_at),
    };
  }

  upsertMemory(key: string, value: string, tokens: number) {
    this.db.run(
      `INSERT INTO memories(key, value, tokens, updated_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, tokens = excluded.tokens, updated_at = excluded.updated_at`,
      key,
      value,
      tokens,
      Date.now(),
    );
  }

  deleteMemory(key: string) {
    return this.db.run("DELETE FROM memories WHERE key = ?", key).changes > 0;
  }

  // ------------------------------------------------------------------- files

  /**
   * Documents are content-addressed: bytes already in the library return the row
   * that holds them instead of opening a second one. Two rows with identical text
   * are two copies of every chunk and every vector, and retrieval then spends the
   * agent's context on the same passage twice — deduping by `chunkId` cannot see
   * it, because the duplicates are different chunks.
   *
   * Images are exempt. An image's id is also the handle for its provenance row,
   * its metadata sidecar and its thumbnail cache, so collapsing two of them
   * saves one file and dangles three references.
   */
  addFile(input: {
    id?: string;
    name: string;
    mime: string;
    bytes: number;
    diskPath: string;
    sha256: string;
    conversationId?: string | null;
    source?: string;
    pageCount?: number | null;
    width?: number | null;
    height?: number | null;
    /** Adopted and migrated files keep the time they were actually produced. */
    createdAt?: number;
  }) {
    if (!input.mime.startsWith("image/")) {
      const existing = this.documentBySha256(input.sha256);
      if (existing) return existing;
    }
    const id = input.id ?? newId("file");
    this.db.run(
      `INSERT INTO files(id, name, mime, bytes, disk_path, sha256, conversation_id, source, page_count, width, height, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.mime,
      input.bytes,
      input.diskPath,
      input.sha256,
      input.conversationId ?? null,
      input.source ?? "upload",
      input.pageCount ?? null,
      input.width ?? null,
      input.height ?? null,
      input.createdAt ?? Date.now(),
    );
    return this.getFile(id)!;
  }

  /** The oldest non-image row holding exactly these bytes, if the library has one. */
  documentBySha256(sha256: string) {
    const row = this.db.get<{ id: string }>(
      `SELECT id FROM files WHERE sha256 = ? AND mime NOT LIKE 'image/%'
        ORDER BY created_at, id LIMIT 1`,
      sha256,
    );
    return row ? this.getFile(String(row.id)) : undefined;
  }

  getFile(id: string) {
    const row = this.db.get(
      `SELECT f.*, (SELECT COUNT(*) FROM chunks c WHERE c.file_id = f.id) AS chunk_count
       FROM files f WHERE f.id = ?`,
      id,
    );
    return row ? toFile(row) : undefined;
  }

  /**
   * The library is filtered and paged in SQL because it holds every generated
   * image as well as every upload: sending the whole table so the browser can
   * filter it would be hundreds of rows the user never looks at.
   */
  listFiles(query: FileQuery = {}): { items: FileRecord[]; total: number; facets: FileFacets } {
    const limit = Math.min(200, Math.max(1, query.limit ?? 60));
    const offset = Math.max(0, query.offset ?? 0);
    const kind = filterByKind(query.kind);
    const source = query.source && query.source !== "all" ? "f.source = ?" : "";
    const text = query.query?.trim() ? "f.name LIKE ?" : "";
    const like = `%${query.query?.trim() ?? ""}%`;
    const where = (...parts: string[]) => {
      const kept = parts.filter(Boolean);
      return kept.length ? `WHERE ${kept.join(" AND ")}` : "";
    };
    const args = (...parts: Array<[string, unknown]>) =>
      parts.filter(([clause]) => clause).map(([, value]) => value);

    const items = this.db
      .all(
        `SELECT f.*, (SELECT COUNT(*) FROM chunks c WHERE c.file_id = f.id) AS chunk_count
           FROM files f ${where(kind, source, text)}
          ORDER BY f.created_at DESC, f.id LIMIT ? OFFSET ?`,
        ...args([source, query.source], [text, like]),
        limit,
        offset,
      )
      .map((row) => ({ ...toFile(row), chunkCount: Number(row.chunk_count) }));

    const total = Number(
      this.db.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM files f ${where(kind, source, text)}`,
        ...args([source, query.source], [text, like]),
      )?.total ?? 0,
    );

    // Each facet counts what the user would get by changing only that one
    // filter, so the numbers on the chips match what clicking them shows.
    const byKind = this.db.get<{ docs: number; images: number; everything: number }>(
      `SELECT COUNT(*) AS everything,
              SUM(CASE WHEN f.mime LIKE 'image/%' THEN 0 ELSE 1 END) AS docs,
              SUM(CASE WHEN f.mime LIKE 'image/%' THEN 1 ELSE 0 END) AS images
         FROM files f ${where(source, text)}`,
      ...args([source, query.source], [text, like]),
    );
    const sources = this.db
      .all<{ source: string; count: number }>(
        `SELECT f.source AS source, COUNT(*) AS count FROM files f ${where(kind, text)}
          GROUP BY f.source ORDER BY count DESC`,
        ...args([text, like]),
      )
      .map((row) => ({ id: String(row.source), count: Number(row.count) }));

    return {
      items,
      total,
      facets: {
        kinds: {
          all: Number(byKind?.everything ?? 0),
          docs: Number(byKind?.docs ?? 0),
          images: Number(byKind?.images ?? 0),
        },
        sources,
      },
    };
  }

  fileIds() {
    return this.db.all<{ id: string }>("SELECT id FROM files").map((row) => String(row.id));
  }

  /** Files eligible for `file_search`, i.e. non-image documents with chunks. */
  searchableFiles() {
    return this.db
      .all(
        `SELECT f.id, f.name FROM files f
         WHERE f.mime NOT LIKE 'image/%' AND EXISTS (SELECT 1 FROM chunks c WHERE c.file_id = f.id)
         ORDER BY f.created_at DESC`,
      )
      .map((row) => ({ id: String(row.id), name: String(row.name) }));
  }

  fileSummaries(ids: string[]) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .all(`SELECT id, name, mime FROM files WHERE id IN (${placeholders})`, ...ids)
      .map((row) => ({ id: String(row.id), name: String(row.name), mime: String(row.mime) }));
  }

  /** Rewrites the bookkeeping for a file whose bytes were replaced in place. */
  updateFileContent(id: string, input: { name: string; bytes: number; sha256: string }) {
    this.db.run(
      "UPDATE files SET name = ?, bytes = ?, sha256 = ? WHERE id = ?",
      input.name,
      input.bytes,
      input.sha256,
      id,
    );
    return this.getFile(id)!;
  }

  setFileEmbeddingStatus(id: string, status: EmbeddingStatus, error?: string) {
    this.db.run(
      "UPDATE files SET embedding_status = ?, embedding_error = ? WHERE id = ?",
      status,
      error ?? null,
      id,
    );
  }

  deleteFile(id: string) {
    const file = this.getFile(id);
    this.db.run("DELETE FROM files WHERE id = ?", id);
    // Chunks and their vectors go with it, by cascade rather than by statement.
    this.vectorRevision += 1;
    return file;
  }

  fileIndexSummary() {
    const row = this.db.get<{ total: number; ready: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN embedding_status = 'ready' THEN 1 ELSE 0 END) AS ready
       FROM files WHERE mime NOT LIKE 'image/%'`,
    );
    return { total: Number(row?.total ?? 0), ready: Number(row?.ready ?? 0) };
  }

  // ------------------------------------------------------------------ chunks

  replaceChunks(fileId: string, chunks: Array<{ idx: number; page: number | null; text: string }>) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM chunks WHERE file_id = ?", fileId);
      for (const chunk of chunks) {
        this.db.run(
          "INSERT INTO chunks(id, file_id, idx, page, text) VALUES(?, ?, ?, ?, ?)",
          `${fileId}:chunk:${chunk.idx}`,
          fileId,
          chunk.idx,
          chunk.page,
          chunk.text,
        );
      }
    });
    // Re-chunking drops the old chunks, and their vectors with them.
    this.vectorRevision += 1;
  }

  chunks(fileId: string): ChunkRow[] {
    return this.db
      .all("SELECT * FROM chunks WHERE file_id = ? ORDER BY idx", fileId)
      .map(toChunk);
  }

  chunksByIds(ids: string[]): ChunkRow[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.all(`SELECT * FROM chunks WHERE id IN (${placeholders})`, ...ids).map(toChunk);
  }

  /**
   * Words in a query, in any script.
   *
   * The old split listed the delimiters by hand — `,，。;；、` and a few quote
   * marks — which is the same trap the chunker was in: it knew about Chinese
   * and English and nothing else. Unicode already classifies every separator
   * and every punctuation mark, so asking it covers scripts nobody typed here.
   */
  private static terms(query: string) {
    // Underscore and hyphen are punctuation to Unicode (`Pc` and `Pd`) and part
    // of the word to a programmer, so they are held back from the split. Letting
    // them through turned `file_search` into `file` OR `search`, and the exact
    // identifier — the thing most worth finding in a library of code and specs —
    // became the one query that could not be asked.
    return query
      .split(/(?:(?![_-])[\s\p{P}\p{S}])+/u)
      .map((term) => term.trim())
      .filter(Boolean);
  }

  /**
   * Full-text candidates.
   *
   * The trigram index cannot answer a term shorter than three characters, and
   * in Chinese that is an ordinary word — so short terms are matched as
   * substrings instead. The two halves used to be alternatives, with the
   * substring half reached only when the index half found nothing at all. That
   * lost half of every mixed query: `幂等 idempotent` is served entirely by the
   * index on the English word, so `幂等` contributed nothing and passages that
   * only said `幂等` were invisible. The halves also disagreed — the index ORs
   * its terms, the substring branch ANDed them — so the same question asked in
   * Chinese returned strictly narrower results than in English.
   *
   * Both run, and their rankings are fused the way `retrieval.ts` fuses keyword
   * against semantic, for the same reason: two orderings that mean different
   * things cannot be compared, but their ranks can.
   */
  keywordChunks(query: string, limit: number): Array<ChunkRow & { score: number }> {
    const terms = Store.terms(query);
    if (!terms.length) return [];
    const indexed = this.ftsChunks(terms.filter((term) => [...term].length >= 3), limit);
    const scanned = this.likeChunks(terms, limit);

    const fused = new Map<string, { row: ChunkRow; score: number }>();
    for (const list of [indexed, scanned]) {
      list.forEach((row, rank) => {
        const previous = fused.get(row.id);
        const score = (previous?.score ?? 0) + 1 / (60 + rank + 1);
        fused.set(row.id, { row, score });
      });
    }
    return [...fused.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.row, score: entry.score }));
  }

  /** bm25-ranked hits for the terms the trigram index can serve. */
  private ftsChunks(terms: string[], limit: number): ChunkRow[] {
    if (!terms.length) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    try {
      return this.db
        .all(
          `SELECT c.* FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
          match,
          limit,
        )
        .map(toChunk);
    } catch {
      // A malformed FTS expression should cost this branch, not the tool call.
      return [];
    }
  }

  /**
   * Substring hits, ranked by how many of the query's terms a chunk contains.
   *
   * Ranking used to be `ORDER BY length(text)`, which is not relevance: for a
   * two-character Chinese query a table-of-contents line beat the paragraph
   * that explained the term, and with a limit in play it displaced it.
   */
  private likeChunks(terms: string[], limit: number): ChunkRow[] {
    const needles = terms.map((term) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
    const hits = needles.map(() => "(text LIKE ? ESCAPE '\\')").join(" + ");
    return this.db
      .all(
        `SELECT * FROM (SELECT c.*, ${hits} AS hits FROM chunks c) WHERE hits > 0
         ORDER BY hits DESC, length(text) LIMIT ?`,
        ...needles,
        limit,
      )
      .map(toChunk);
  }

  // -------------------------------------------------------------- embeddings

  /**
   * Counter for every write that can change the vector set. Retrieval keeps the
   * matrix packed in memory and has no other way to learn that it went stale:
   * most of these deletions are SQLite's own cascade from `chunks` and `files`,
   * which no statement here mentions.
   */
  private vectorRevision = 0;

  embeddingRevision() {
    return this.vectorRevision;
  }

  replaceEmbeddings(
    fileId: string,
    model: string,
    rows: Array<{ chunkId: string; vector: Float32Array }>,
  ) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM embeddings WHERE file_id = ?", fileId);
      for (const row of rows) {
        this.db.run(
          "INSERT INTO embeddings(chunk_id, file_id, model, dim, vector) VALUES(?, ?, ?, ?, ?)",
          row.chunkId,
          fileId,
          model,
          row.vector.length,
          Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength),
        );
      }
    });
    this.vectorRevision += 1;
  }

  /** How much there is to score, and whether the answer changed since last time. */
  embeddingSummary(model: string) {
    const row = this.db.get<{ rows: number; dim: number | null }>(
      "SELECT COUNT(*) AS rows, MAX(dim) AS dim FROM embeddings WHERE model = ?",
      model,
    );
    return { rows: Number(row?.rows ?? 0), dim: Number(row?.dim ?? 0), revision: this.vectorRevision };
  }

  /**
   * Vectors for one model, packed into one `Float32Array` per page instead of one
   * per row. At 4096 dimensions a row is 16 KB, so the old row-at-a-time decode
   * allocated two objects and copied 16 KB for every chunk in the corpus on every
   * single search; a page amortises that into one allocation per few hundred rows
   * and lets a corpus too large to hold in memory still be scored in bounded
   * space.
   *
   * Keyset pagination on the primary key, so a page costs an index seek rather
   * than a scan over the rows before it.
   */
  *embeddingPages(model: string, dim: number, rowsPerPage: number): Generator<EmbeddingPage> {
    const size = Math.max(1, rowsPerPage);
    let after = "";
    for (;;) {
      const rows = this.db.all<{ chunk_id: string; file_id: string; vector: Uint8Array }>(
        `SELECT chunk_id, file_id, vector FROM embeddings
          WHERE model = ? AND dim = ? AND chunk_id > ? ORDER BY chunk_id LIMIT ?`,
        model,
        dim,
        after,
        size,
      );
      if (!rows.length) return;
      yield packVectors(rows, dim);
      if (rows.length < size) return;
      after = String(rows[rows.length - 1]!.chunk_id);
    }
  }

  embeddingCount(model?: string) {
    const row = model
      ? this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM embeddings WHERE model = ?", model)
      : this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM embeddings");
    return Number(row?.count ?? 0);
  }

  // ------------------------------------------------------------ image assets

  registerImageAsset(meta: unknown): ImageAsset | undefined {
    const value = meta as Record<string, unknown> | null;
    const imageId = typeof value?.image_id === "string" ? value.image_id.toLowerCase() : "";
    if (!/^img_[0-9a-f]{32}$/.test(imageId)) return undefined;
    const parents = Array.isArray(value?.parent_image_ids) ? value.parent_image_ids.map(String) : [];
    this.db.run(
      `INSERT INTO image_assets(image_id, mime, width, height, provider, model, parent_image_ids, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(image_id) DO UPDATE SET
         mime = excluded.mime, width = excluded.width, height = excluded.height,
         provider = excluded.provider, model = excluded.model, parent_image_ids = excluded.parent_image_ids`,
      imageId,
      String(value?.mime_type ?? "image/png"),
      value?.width == null ? null : Number(value.width),
      value?.height == null ? null : Number(value.height),
      value?.provider == null ? null : String(value.provider),
      value?.model == null ? null : String(value.model),
      JSON.stringify(parents),
      Date.now(),
    );
    return this.getImageAsset(imageId);
  }

  getImageAsset(imageId: string): ImageAsset | undefined {
    const row = this.db.get("SELECT * FROM image_assets WHERE image_id = ?", imageId);
    return row ? toImageAsset(row) : undefined;
  }

  // ------------------------------------------------------------ video assets

  registerVideoAsset(meta: {
    videoId: string;
    mime: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    posterImageId?: string | null;
    provider?: string | null;
    model?: string | null;
    parents?: string[];
  }): VideoAsset | undefined {
    const videoId = meta.videoId.toLowerCase();
    if (!/^vid_[0-9a-f]{32}$/.test(videoId)) return undefined;
    this.db.run(
      `INSERT INTO video_assets(video_id, mime, width, height, duration_ms, poster_image_id,
                                provider, model, parent_image_ids, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         mime = excluded.mime, width = excluded.width, height = excluded.height,
         duration_ms = excluded.duration_ms, poster_image_id = excluded.poster_image_id,
         provider = excluded.provider, model = excluded.model,
         parent_image_ids = excluded.parent_image_ids`,
      videoId,
      meta.mime || "video/mp4",
      meta.width ?? null,
      meta.height ?? null,
      meta.durationMs ?? null,
      meta.posterImageId ?? null,
      meta.provider ?? null,
      meta.model ?? null,
      JSON.stringify(meta.parents ?? []),
      Date.now(),
    );
    return this.getVideoAsset(videoId);
  }

  getVideoAsset(videoId: string): VideoAsset | undefined {
    const row = this.db.get("SELECT * FROM video_assets WHERE video_id = ?", videoId);
    return row ? toVideoAsset(row) : undefined;
  }

  // ---------------------------------------------------------------- profiles

  listProfiles(): Profile[] {
    return this.db.all("SELECT * FROM profiles ORDER BY sort_order, name").map(toProfile);
  }

  getProfile(id: string): Profile | undefined {
    const row = this.db.get("SELECT * FROM profiles WHERE id = ?", id);
    return row ? toProfile(row) : undefined;
  }

  upsertProfile(input: ProfileInput & { id: string }) {
    const now = Date.now();
    const existing = this.getProfile(input.id);
    const sortOrder = input.sortOrder ?? existing?.sortOrder ?? this.nextSortOrder("profiles");
    this.db.run(
      `INSERT INTO profiles(id, name, chat_model_id, image_model_id, edit_model_id, video_model_id,
                            capabilities, mcp_servers, global_prompt, tool_prompt, sort_order,
                            created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, chat_model_id = excluded.chat_model_id,
         image_model_id = excluded.image_model_id, edit_model_id = excluded.edit_model_id,
         video_model_id = excluded.video_model_id, capabilities = excluded.capabilities,
         mcp_servers = excluded.mcp_servers, global_prompt = excluded.global_prompt,
         tool_prompt = excluded.tool_prompt, sort_order = excluded.sort_order,
         updated_at = excluded.updated_at`,
      input.id,
      input.name,
      input.chatModelId ?? existing?.chatModelId ?? "",
      input.imageModelId ?? existing?.imageModelId ?? "",
      input.editModelId ?? existing?.editModelId ?? "",
      input.videoModelId ?? existing?.videoModelId ?? "",
      JSON.stringify(input.capabilities ?? existing?.capabilities ?? {}),
      JSON.stringify(input.mcpServers ?? existing?.mcpServers ?? []),
      input.globalPrompt ?? existing?.globalPrompt ?? "",
      input.toolPrompt ?? existing?.toolPrompt ?? "",
      sortOrder,
      existing?.createdAt ?? now,
      now,
    );
    return this.getProfile(input.id)!;
  }

  deleteProfile(id: string) {
    this.db.run("DELETE FROM profiles WHERE id = ?", id);
    // Conversations fall back to the default profile rather than to nothing.
    this.db.run("UPDATE conversations SET profile_id = '' WHERE profile_id = ?", id);
  }

  // -------------------------------------------------------------------- jobs

  createJob(
    input: JobInput & { id?: string; kind: "image" | "video"; op: GenerationOp; modelName: string },
  ): JobRecord {
    const id = input.id ?? newId("job");
    const now = Date.now();
    this.db.run(
      `INSERT INTO jobs(id, kind, op, model_id, model_name, conversation_id, status, progress, note,
                        params, sources, assets, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, '[]', ?, ?)`,
      id,
      input.kind,
      input.op,
      input.modelId,
      input.modelName,
      input.conversationId ?? null,
      JSON.stringify(input.params ?? {}),
      JSON.stringify(input.sources ?? []),
      now,
      now,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db.get("SELECT * FROM jobs WHERE id = ?", id);
    return row ? toJob(row) : undefined;
  }

  /**
   * The job that produced an asset, which is where its prompt and parameters are.
   * The asset row carries the backend and the parents and deliberately not these:
   * a job already records what was asked for, and copying it would give two
   * answers that could disagree.
   *
   * Newest wins. An asset id is content-addressed, so a request repeated with the
   * same parameters and the same seed lands on the row it already had, and the
   * most recent job is the one whose parameters were in force.
   */
  jobForAsset(assetId: string): JobRecord | undefined {
    const row = this.db.get(
      `SELECT * FROM jobs
        WHERE EXISTS (SELECT 1 FROM json_each(jobs.assets) WHERE json_extract(value, '$.assetId') = ?)
        ORDER BY created_at DESC LIMIT 1`,
      assetId,
    );
    return row ? toJob(row) : undefined;
  }

  listJobs(options: { status?: JobStatus; conversationId?: string; limit?: number } = {}): JobRecord[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    return this.db
      .all(
        `SELECT * FROM jobs
         WHERE (? IS NULL OR status = ?) AND (? IS NULL OR conversation_id = ?)
         ORDER BY created_at DESC LIMIT ?`,
        options.status ?? null,
        options.status ?? null,
        options.conversationId ?? null,
        options.conversationId ?? null,
        limit,
      )
      .map(toJob);
  }

  /** Jobs interrupted by a restart, oldest first, so recovery replays in order. */
  unsettledJobs(): JobRecord[] {
    return this.db
      .all("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at")
      .map(toJob);
  }

  markJobRunning(id: string, providerJobId?: string) {
    const now = Date.now();
    this.db.run(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?,
        provider_job_id = COALESCE(?, provider_job_id) WHERE id = ?`,
      now,
      now,
      providerJobId ?? null,
      id,
    );
  }

  setJobProgress(id: string, progress: number | null, note?: string | null) {
    this.db.run(
      "UPDATE jobs SET progress = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
      progress,
      note ?? null,
      Date.now(),
      id,
    );
  }

  setJobProviderId(id: string, providerJobId: string) {
    this.db.run(
      "UPDATE jobs SET provider_job_id = ?, updated_at = ? WHERE id = ?",
      providerJobId,
      Date.now(),
      id,
    );
  }

  settleJob(
    id: string,
    status: Extract<JobStatus, "succeeded" | "failed" | "cancelled">,
    outcome: { assets?: GeneratedAsset[]; error?: string | null } = {},
  ) {
    const now = Date.now();
    this.db.run(
      `UPDATE jobs SET status = ?, assets = ?, error = ?, progress = CASE WHEN ? = 'succeeded' THEN 1 ELSE progress END,
        finished_at = ?, updated_at = ? WHERE id = ?`,
      status,
      JSON.stringify(outcome.assets ?? []),
      outcome.error ?? null,
      status,
      now,
      now,
      id,
    );
    return this.getJob(id)!;
  }

  // ----------------------------------------------------------------- secrets

  hasSecret(name: string) {
    return Boolean(this.db.get("SELECT 1 FROM secrets WHERE name = ?", name));
  }

  readSecretRow(name: string) {
    return this.db.get<{ iv: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }>(
      "SELECT iv, tag, ciphertext FROM secrets WHERE name = ?",
      name,
    );
  }

  writeSecretRow(name: string, iv: Buffer, tag: Buffer, ciphertext: Buffer) {
    this.db.run(
      `INSERT INTO secrets(name, iv, tag, ciphertext, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag,
         ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      name,
      iv,
      tag,
      ciphertext,
      Date.now(),
    );
  }

  deleteSecret(name: string) {
    this.db.run("DELETE FROM secrets WHERE name = ?", name);
  }

  listSecretNames() {
    return this.db.all<{ name: string }>("SELECT name FROM secrets").map((row) => row.name);
  }
}

function toModelSpec(row: Record<string, unknown>): ModelSpec {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    name: String(row.name),
    model: String(row.model),
    enabled: bool(row.enabled),
    pinned: bool(row.pinned),
    agentTool: bool(row.agent_tool),
    reasoning: bool(row.reasoning),
    input: json<Array<"text" | "image">>(row.input, ["text"]),
    contextWindow: Number(row.context_window),
    maxTokens: Number(row.max_tokens),
    thinkingLevel: String(row.thinking_level) as ThinkingLevel,
    thinkingLevelMap: json<ModelSpec["thinkingLevelMap"]>(row.thinking_level_map, null),
    apiMode: String(row.api_mode) as ApiMode,
    kind: (String(row.kind ?? "chat") || "chat") as ModelKind,
    ops: json<GenerationOp[]>(row.ops, []),
    params: json<Record<string, unknown> | null>(row.params, null),
    librechatCompat: bool(row.librechat_compat),
    systemPrompt: (row.system_prompt as string | null) ?? null,
    temperature: row.temperature == null ? null : Number(row.temperature),
    topP: row.top_p == null ? null : Number(row.top_p),
    pricing: json<ModelSpec["pricing"]>(row.pricing, null),
    compat: json<Record<string, unknown> | null>(row.compat, null),
    sortOrder: Number(row.sort_order),
  };
}

function toFile(row: Record<string, unknown>): FileRecord & { diskPath: string; sha256: string } {
  return {
    id: String(row.id),
    name: String(row.name),
    mime: String(row.mime),
    bytes: Number(row.bytes),
    diskPath: String(row.disk_path),
    sha256: String(row.sha256),
    conversationId: (row.conversation_id as string | null) ?? null,
    source: String(row.source),
    embeddingStatus: String(row.embedding_status) as EmbeddingStatus,
    embeddingError: (row.embedding_error as string | null) ?? null,
    chunkCount: Number(row.chunk_count ?? 0),
    pageCount: row.page_count == null ? null : Number(row.page_count),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    createdAt: Number(row.created_at),
  };
}

function toImageAsset(row: Record<string, unknown>): ImageAsset {
  return {
    imageId: String(row.image_id),
    mime: String(row.mime),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    provider: (row.provider as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    parentImageIds: json<string[]>(row.parent_image_ids, []),
    createdAt: Number(row.created_at),
  };
}

function toVideoAsset(row: Record<string, unknown>): VideoAsset {
  return {
    videoId: String(row.video_id),
    mime: String(row.mime),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    posterImageId: (row.poster_image_id as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    parentImageIds: json<string[]>(row.parent_image_ids, []),
    createdAt: Number(row.created_at),
  };
}

/** Missing keys mean "not offered", so an older row does not silently gain tools. */
function toProfile(row: Record<string, unknown>): Profile {
  const capabilities = json<Partial<Profile["capabilities"]>>(row.capabilities, {});
  return {
    id: String(row.id),
    name: String(row.name),
    chatModelId: String(row.chat_model_id ?? ""),
    imageModelId: String(row.image_model_id ?? ""),
    editModelId: String(row.edit_model_id ?? ""),
    videoModelId: String(row.video_model_id ?? ""),
    capabilities: {
      memory: capabilities.memory ?? false,
      files: capabilities.files ?? false,
      web: capabilities.web ?? false,
      coding: capabilities.coding ?? false,
      skills: capabilities.skills ?? false,
      generation: capabilities.generation ?? false,
    },
    mcpServers: json<string[]>(row.mcp_servers, []),
    globalPrompt: String(row.global_prompt ?? ""),
    toolPrompt: String(row.tool_prompt ?? ""),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as JobRecord["kind"],
    op: String(row.op) as GenerationOp,
    modelId: String(row.model_id),
    modelName: String(row.model_name ?? ""),
    conversationId: (row.conversation_id as string | null) ?? null,
    status: String(row.status) as JobStatus,
    progress: row.progress == null ? null : Number(row.progress),
    note: (row.note as string | null) ?? null,
    params: json<Record<string, unknown>>(row.params, {}),
    sources: json<string[]>(row.sources, []),
    assets: json<GeneratedAsset[]>(row.assets, []),
    error: (row.error as string | null) ?? null,
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Not on JobRecord: the backend's id is an implementation detail of recovery. */
export function jobProviderId(store: Store, id: string) {
  const row = store.db.get<{ provider_job_id: string | null }>(
    "SELECT provider_job_id FROM jobs WHERE id = ?",
    id,
  );
  return row?.provider_job_id ?? null;
}

function toChunk(row: Record<string, unknown>): ChunkRow {
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    idx: Number(row.idx),
    page: row.page == null ? null : Number(row.page),
    text: String(row.text),
  };
}

function toStoredMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    seq: Number(row.seq),
    role: String(row.role),
    content: json<unknown>(row.content, null),
    createdAt: Number(row.created_at),
  };
}

function toApproval(row: Record<string, unknown>): Approval {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    toolName: String(row.tool_name),
    action: String(row.action),
    summary: String(row.summary),
    detail: json<Record<string, unknown>>(row.detail, {}),
    status: String(row.status) as ApprovalStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toEvent(row: Record<string, unknown>): StoredEvent {
  return {
    seq: Number(row.seq),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    type: String(row.type),
    data: json<unknown>(row.data, {}),
    createdAt: Number(row.created_at),
  };
}

/**
 * Copies stored blobs into one matrix. The blob's own buffer cannot be viewed as
 * a `Float32Array` in place: node:sqlite hands back a view into a larger buffer
 * at an arbitrary offset, and a `Float32Array` needs four-byte alignment.
 */
function packVectors(
  rows: Array<{ chunk_id: string; file_id: string; vector: Uint8Array }>,
  dim: number,
): EmbeddingPage {
  const stride = dim * 4;
  const data = new Float32Array(rows.length * dim);
  const bytes = new Uint8Array(data.buffer);
  const chunkIds: string[] = [];
  const fileIds: string[] = [];
  rows.forEach((row, index) => {
    chunkIds.push(String(row.chunk_id));
    fileIds.push(String(row.file_id));
    bytes.set(row.vector.subarray(0, stride), index * stride);
  });
  return { chunkIds, fileIds, dim, data };
}
