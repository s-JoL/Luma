import type { ConversationSearchHit, StoredMessage } from "@shared/types.ts";
import type { Store } from "../store/store.ts";
import { messageText } from "./messages.ts";
import type { Sessions } from "./sessions.ts";

/** Characters of context kept on either side of the match. */
const SNIPPET_MARGIN = 80;

/** Hits resolved against the projection in one round trip. */
const BATCH = 64;

/**
 * Hits examined before the search gives up. Reached only when a word is common
 * in text the agent read but rare in what anyone said, and a walk that long has
 * already cost more than the answer is worth.
 */
const SCAN_LIMIT = 2_000;

/** Roles a reader can be scrolled to. Tool traffic is not part of the transcript. */
const READABLE = ["user", "assistant"];

/** Shortest query the tree's trigram index can answer. Below it, scan instead. */
const TRIGRAM = 3;

/**
 * Searching every conversation at once, over the session trees rather than the
 * `messages` table: the index and its triggers come from pi's SQLite session
 * backend, so this module only has to decide which hits a reader can actually
 * be taken to, and what to show them.
 *
 * A hit is dropped when it is not on the current branch — an abandoned turn is
 * still in the tree, but the transcript has no place to scroll to — and when it
 * matched only the payload's structure, a tool's output, or a file the agent
 * read, rather than a sentence someone said. The trigram index cannot tell those
 * apart, so the walk keeps going until enough readable hits are found.
 *
 * A one- or two-character query has no trigram to look up at all, and in Chinese
 * that is an ordinary word, so those scan the projection directly instead of
 * reporting that nothing was ever said about 幂等.
 */
export async function searchConversations(
  store: Store,
  sessions: Sessions,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ConversationSearchHit[]> {
  const text = query.trim();
  if (!text) return [];

  const needle = text.toLowerCase();
  const results: ConversationSearchHit[] = [];

  const keep = (row: StoredMessage) => {
    const body = messageText(row.content);
    const at = body.toLowerCase().indexOf(needle);
    if (at < 0) return;
    const conversation = store.getConversation(row.conversationId);
    if (!conversation) return;
    results.push({
      conversationId: row.conversationId,
      title: conversation.title,
      seq: row.seq,
      role: row.role,
      snippet: snippet(body, at, text.length),
      createdAt: row.createdAt,
    });
  };

  if ([...text].length < TRIGRAM) {
    for (const row of store.messagesContaining(text, READABLE, limit * 4)) {
      if (results.length >= limit) break;
      keep(row);
    }
    return results;
  }

  const resolve = (batch: SearchHit[]) => {
    const rows = store.messagesByEntryIds(batch.map((hit) => hit.entryId));
    for (const hit of batch) {
      if (results.length >= limit) return;
      const row = rows.get(hit.entryId);
      if (!row || row.conversationId !== hit.sessionId || !READABLE.includes(row.role)) continue;
      keep(row);
    }
  };

  let batch: SearchHit[] = [];
  let scanned = 0;
  for await (const hit of sessions.search(text, signal)) {
    batch.push(hit);
    scanned += 1;
    if (batch.length < BATCH) continue;
    resolve(batch);
    batch = [];
    if (results.length >= limit || scanned >= SCAN_LIMIT) break;
  }
  if (results.length < limit) resolve(batch);
  return results;
}

/** Only the parts of a session hit this module resolves against the projection. */
interface SearchHit {
  sessionId: string;
  entryId: string;
}

/** The match with enough around it to read, and ellipses where text was cut. */
function snippet(body: string, at: number, length: number) {
  const start = Math.max(0, at - SNIPPET_MARGIN);
  const end = Math.min(body.length, at + length + SNIPPET_MARGIN);
  const middle = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${middle}${end < body.length ? "…" : ""}`;
}
