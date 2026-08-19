import {
  buildSessionContext,
  Session,
  SessionError,
  type Entry,
  type SessionSearch,
  type SessionStats,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createNodeSqliteFactory,
  createSqliteSessionSearch,
  SqliteSessionRepository,
  type SqliteSessionMetadata,
  type SqliteSessionSearchHit,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { paths } from "../env.ts";

/** The only lane Luma uses. Branches are expressed by moving it, not by naming more. */
export const LANE = "main";

export type ConversationSession = Session<SqliteSessionMetadata>;

/**
 * The conversation tree, and the transcript's source of truth.
 *
 * A flat message list cannot express the three things a complete agent needs:
 * where a rewound turn went (so it can be recovered), that history before a
 * point has been replaced by a summary, and what each turn cost. pi's session
 * records all of it as an append-only tree of entries plus an operation log, so
 * the `messages` table becomes a projection of this (see `projection.ts`).
 */
export class Sessions {
  private readonly repo: SqliteSessionRepository;
  /** Keyed by conversation id; a rejected open is not cached. */
  private readonly opening = new Map<string, Promise<Session<SqliteSessionMetadata>>>();
  private readonly fts: SessionSearch<SqliteSessionSearchHit>;

  constructor(
    private readonly databasePath: string = paths.sessionsDb,
    /** Recorded on each session for provenance. The agent's sandbox root is separate. */
    private readonly cwd: string = paths.data,
  ) {
    const env = new NodeExecutionEnv({ cwd });
    const sqlite = createNodeSqliteFactory();
    this.repo = new SqliteSessionRepository({
      env,
      sqlite,
      databasePath,
      // Luma is one process, so the writer lease only guards against a second
      // copy of the server, and pi's default 10s heartbeat would write to disk
      // every ten seconds for every conversation opened since boot. The TTL is
      // the cost of that: a lease is only taken over once it has expired, so an
      // unclean exit makes a conversation unopenable for exactly this long — a
      // minute is a tolerable wait, the five it used to be is not.
      writerLease: { ttlMs: 60_000, heartbeatIntervalMs: 20_000 },
    });
    // Reads the same file through its own short-lived connection, and installs
    // an FTS index over `entries` with triggers, so writes made by the
    // repository keep it current without either side knowing about the other.
    this.fts = createSqliteSessionSearch({ env, sqlite, databasePath });
  }

  /**
   * Full-text search across every conversation, best-relevance first.
   *
   * The index covers the raw entry payloads, so a hit can land on an abandoned
   * branch or on a part of a message a reader never sees. Deciding which hits
   * are showable is the caller's job (`search.ts`), because only the projection
   * knows what is currently on screen.
   *
   * Deliberately unbounded and lazy: a word that appears in the text of a file
   * the agent read is a hit on every tool result that quoted it, and those score
   * above the one sentence a reader was looking for. Asking for a fixed page and
   * filtering it afterwards would answer "no matches" while the match sat just
   * past the page. The caller stops the walk instead, and the underlying cursor
   * closes with it.
   */
  search(query: string, signal?: AbortSignal): AsyncIterable<SqliteSessionSearchHit> {
    return this.fts.search(query, { entryTypes: ["message"], signal });
  }

  /**
   * One session per conversation, keyed by the conversation id so a restart
   * reattaches to the same tree. Re-opening an open session hands back the same
   * storage, so callers share one writer claim rather than fighting over it.
   */
  session(conversationId: string): Promise<Session<SqliteSessionMetadata>> {
    let pending = this.opening.get(conversationId);
    if (!pending) {
      pending = this.load(conversationId).catch((error: unknown) => {
        this.opening.delete(conversationId);
        throw error;
      });
      this.opening.set(conversationId, pending);
    }
    return pending;
  }

  private async load(conversationId: string) {
    try {
      return await this.repo.open(this.metadata(conversationId));
    } catch (error) {
      // A conversation that predates the session store, or a brand new one,
      // simply has no tree yet.
      if (error instanceof SessionError && error.code === "not_found") {
        return await this.repo.create({ id: conversationId, cwd: this.cwd });
      }
      throw error;
    }
  }

  private metadata(conversationId: string): SqliteSessionMetadata {
    return { id: conversationId, createdAt: 0, cwd: this.cwd, path: this.databasePath };
  }

  /** The current branch, oldest first: what both the context and the projection derive from. */
  async entries(conversationId: string): Promise<Entry[]> {
    const session = await this.session(conversationId);
    return session.findEntriesOnBranch({ order: "oldestFirst" });
  }

  /**
   * The messages to send the model. Everything before the newest compaction
   * entry collapses into that entry's summary plus its retained tail, which is
   * what keeps a long conversation inside the context window without deleting
   * anything the reader can still scroll back to.
   */
  async context(conversationId: string) {
    return buildSessionContext(await this.entries(conversationId));
  }

  async stats(conversationId: string): Promise<SessionStats> {
    return (await this.session(conversationId)).getStats();
  }

  /**
   * Closes operations that a crash left open. The lane refuses to start a second
   * operation while one is open, so without this a conversation interrupted by a
   * hard restart could never run again.
   */
  async recover(conversationId: string) {
    const session = await this.session(conversationId);
    const open = await session.findOpenOperations(LANE);
    for (const operation of open) {
      await session.appendRecord({
        type: "operation_finished",
        id: session.idGenerator.next(),
        lane: LANE,
        runId: operation.id,
        outcome: "failed",
        error: { code: "interrupted", message: "服务在这次运行结束前重启了" },
      });
    }
    return open.length;
  }

  /** Rewinds the lane so `entryId` is the newest entry, keeping the abandoned branch. */
  async rewind(conversationId: string, entryId: string | null) {
    const session = await this.session(conversationId);
    await session.moveLane(LANE, entryId);
  }

  async forget(conversationId: string) {
    this.opening.delete(conversationId);
    await this.repo.delete(this.metadata(conversationId));
  }

  async close() {
    this.opening.clear();
    await this.repo.close();
  }
}
