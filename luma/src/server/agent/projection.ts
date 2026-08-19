import type { AgentMessage, Entry, MessageEntry } from "@earendil-works/pi-agent-core";
import type { Store } from "../store/store.ts";
import type { Sessions } from "./sessions.ts";

/**
 * The transcript clients read is a projection of the conversation's tree. This
 * module is the only place that derives one from the other, so there is a single
 * answer to "what does the reader see" — the message entries on the current
 * branch, in branch order.
 *
 * Compaction and branch-summary entries are deliberately not projected: they
 * shape what the *model* is sent, and showing them as messages would tell the
 * reader their own history had been replaced when it is still all there.
 */
function isMessageEntry(entry: Entry): entry is MessageEntry {
  return entry.type === "message";
}

/** True for anything that can be handed back to a model as a message. */
function usableMessage(value: unknown): value is AgentMessage {
  return typeof (value as { role?: unknown } | null)?.role === "string";
}

/** Re-derives the whole transcript from the current branch. */
export async function projectTranscript(store: Store, sessions: Sessions, conversationId: string) {
  const entries = await sessions.entries(conversationId);
  return store.replaceMessages(
    conversationId,
    entries.filter(isMessageEntry).map((entry) => ({ message: entry.message, entryId: entry.id })),
  );
}

/**
 * Drops the turn at `fromSeq` and everything after it, which is what editing or
 * regenerating a message asks for.
 *
 * The branch is moved back to the entry before it rather than the entries being
 * deleted: the model then continues from that point, while the abandoned turn
 * stays in the tree where it can still be recovered. Conversations whose rows
 * predate the tree have nothing to move, so their rows are simply dropped and
 * the next run adopts what is left.
 */
export async function rewindConversation(
  store: Store,
  sessions: Sessions,
  conversationId: string,
  fromSeq: number,
) {
  const entryId = store.messageEntryId(conversationId, fromSeq);
  const session = await sessions.session(conversationId);
  const entry = entryId ? await session.getEntry(entryId) : undefined;
  if (!entry) return store.truncateMessages(conversationId, fromSeq);

  await sessions.rewind(conversationId, entry.parentId);
  return projectTranscript(store, sessions, conversationId);
}

/**
 * Brings a conversation written before the session store into its tree by
 * replaying its transcript rows as entries. Without this the first run after the
 * upgrade would read an empty tree and the model would lose the conversation.
 *
 * Runs once per conversation: afterwards the tree is non-empty and it is a
 * no-op, so it is safe on the hot path.
 */
export async function adoptTranscript(store: Store, sessions: Sessions, conversationId: string) {
  const session = await sessions.session(conversationId);
  if (await session.getLeafId()) return 0;

  let adopted = 0;
  for (const row of store.storedMessages(conversationId)) {
    if (!usableMessage(row.content)) continue;
    const entryId = await session.appendMessage(row.content);
    store.linkMessageEntry(row.id, entryId);
    adopted += 1;
  }
  return adopted;
}
