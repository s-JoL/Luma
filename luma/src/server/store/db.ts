import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

export type Row = Record<string, unknown>;

/**
 * Thin prepared-statement cache over node:sqlite. Every repository in the
 * server shares one instance; SQLite's own locking plus WAL is enough for the
 * single-process design.
 */
export class Db {
  readonly handle: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.handle = new DatabaseSync(file);
    this.handle.exec(fs.readFileSync(SCHEMA, "utf8"));
    this.migrate();
  }

  private columns(table: string) {
    return new Set(
      this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => String(row.name)),
    );
  }

  /**
   * Forward-only column migrations for databases created by an older build.
   * `CREATE TABLE IF NOT EXISTS` cannot add columns, and dropping the file
   * would throw away the user's conversations.
   */
  private migrate() {
    const models = this.columns("models");
    if (models.size && !models.has("api_mode")) {
      this.exec("ALTER TABLE models ADD COLUMN api_mode TEXT NOT NULL DEFAULT 'openai-chat'");
      this.exec("ALTER TABLE models ADD COLUMN librechat_compat INTEGER NOT NULL DEFAULT 0");
      if (models.has("request_profile")) {
        // The old per-model "request profile" collapsed protocol and payload
        // quirks into one enum; split it back into its two real dimensions.
        // The protocol itself used to live on the provider.
        const providerApi = this.columns("providers").has("api")
          ? "(SELECT p.api FROM providers p WHERE p.id = models.provider_id)"
          : "'openai-completions'";
        this.exec(`UPDATE models SET
          api_mode = CASE ${providerApi}
            WHEN 'openai-responses' THEN 'openai-responses'
            WHEN 'anthropic-messages' THEN 'anthropic-messages'
            ELSE 'openai-chat' END,
          librechat_compat = CASE WHEN request_profile = 'librechat-chat-completions' THEN 1 ELSE 0 END`);
      }
    }
    // Pinning split "usable" from "one tap away in chat". Existing models were
    // all in the switcher, so they stay pinned and nothing disappears.
    if (models.size && !models.has("pinned")) {
      this.exec("ALTER TABLE models ADD COLUMN pinned INTEGER NOT NULL DEFAULT 1");
    }
    // Generation models can be handed to the agent one by one. Existing rows opt
    // out, so the tool list a conversation already sees does not change under it.
    if (models.size && !models.has("agent_tool")) {
      this.exec("ALTER TABLE models ADD COLUMN agent_tool INTEGER NOT NULL DEFAULT 0");
    }
    // `api` moved from the provider to the model, so a provider can serve both
    // chat-completions and messages models from one base URL.
    if (this.columns("providers").has("api")) this.exec("ALTER TABLE providers DROP COLUMN api");
    // Transcripts became a projection of the session tree. Rows written before
    // that keep a null entry_id and are adopted into the tree on first use.
    const messages = this.columns("messages");
    if (messages.size && !messages.has("entry_id")) {
      this.exec("ALTER TABLE messages ADD COLUMN entry_id TEXT");
    }
    // Not in schema.sql: it would run before the column above exists on a
    // database created by an older build. A search resolves tree entry ids back
    // to rows through this index.
    this.exec("CREATE INDEX IF NOT EXISTS messages_entry ON messages(entry_id)");
    // Generation became a first-class kind rather than a special api_mode. Rows
    // that predate it are chat, except the ones that were already drawing.
    if (models.size && !models.has("kind")) {
      this.exec("ALTER TABLE models ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
      this.exec("ALTER TABLE models ADD COLUMN ops TEXT NOT NULL DEFAULT '[]'");
      this.exec("ALTER TABLE models ADD COLUMN params TEXT");
      this.exec(
        `UPDATE models SET kind = 'image', ops = '["text_to_image"]' WHERE api_mode = 'openai-images'`,
      );
    }
    const conversations = this.columns("conversations");
    if (conversations.size && !conversations.has("profile_id")) {
      this.exec("ALTER TABLE conversations ADD COLUMN profile_id TEXT NOT NULL DEFAULT ''");
    }
    // A provider can declare how it presents its credential. Null is `bearer`,
    // so every row written before this behaves exactly as it did.
    const providers = this.columns("providers");
    if (providers.size && !providers.has("auth")) {
      this.exec("ALTER TABLE providers ADD COLUMN auth TEXT");
    }
    // An MCP server can live behind a URL rather than a command.
    const mcp = this.columns("mcp_servers");
    if (mcp.size && !mcp.has("url")) {
      this.exec("ALTER TABLE mcp_servers ADD COLUMN url TEXT");
      this.exec("ALTER TABLE mcp_servers ADD COLUMN headers TEXT");
    }
  }

  /**
   * Returns pages that streaming deltas left behind. SQLite hands a deleted
   * page to the freelist but never shrinks the file on its own, so a busy
   * install grows without bound — a real one reached 254 MB of file for 0.6 MB
   * of events. `auto_vacuum` cannot be switched on in place, so a database
   * created before it was set is converted by a full VACUUM the first time;
   * after that the incremental pass is cheap enough to run on every prune.
   *
   * Both statements are no-ops inside a transaction, so this must only be
   * called from an idle path.
   */
  reclaim() {
    const mode = Number(Object.values(this.get<Row>("PRAGMA auto_vacuum") ?? {})[0] ?? 0);
    const free = Number(Object.values(this.get<Row>("PRAGMA freelist_count") ?? {})[0] ?? 0);
    if (mode === 0) {
      // Only worth the rewrite once the dead space is material — 4 MB of pages.
      if (free < 1_000) return 0;
      this.exec("PRAGMA auto_vacuum = INCREMENTAL");
      this.exec("VACUUM");
      return free;
    }
    if (free < 256) return 0;
    this.exec("PRAGMA incremental_vacuum");
    return free;
  }

  private prepare(sql: string) {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.handle.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]) {
    return this.prepare(sql).run(...(params as never[]));
  }

  exec(sql: string) {
    this.handle.exec(sql);
  }

  /**
   * `IMMEDIATE`, not the default deferred `BEGIN`: a deferred transaction takes
   * its write lock at the first write, and an upgrade from a read lock is the one
   * case SQLite refuses to wait out — `busy_timeout` does not cover it, so a
   * concurrent writer surfaces as an immediate SQLITE_BUSY. Taking the lock up
   * front makes the wait the timeout's business. Nothing nests these, and no
   * caller uses savepoints, so there is no inner BEGIN to fail on.
   */
  transaction<T>(fn: () => T): T {
    this.handle.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.handle.exec("COMMIT");
      return result;
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.cache.clear();
    this.handle.close();
  }
}

export function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const bool = (value: unknown) => value === 1 || value === true || value === "1";
