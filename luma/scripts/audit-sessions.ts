/**
 * The conversation tree and the transcript projected from it, tested without a
 * model or a server: persistence across a reopen, the context projection that
 * collapses a compaction, rewinding a branch without losing the abandoned turn,
 * the usage ledger, full-text search across conversations, and that the reader
 * and the model always agree.
 *
 *   node --import tsx scripts/audit-sessions.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { adoptTranscript, projectTranscript, rewindConversation } from "../src/server/agent/projection.ts";
import { searchConversations } from "../src/server/agent/search.ts";
import { LANE, Sessions } from "../src/server/agent/sessions.ts";
import { Db } from "../src/server/store/db.ts";
import { Store } from "../src/server/store/store.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "luma-session-"));
const databasePath = path.join(sandbox, "sessions.sqlite");

let failures = 0;

async function check(name: string, run: () => Promise<string | void> | string | void) {
  try {
    const note = await run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;
const assistant = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    model: "test-model",
    provider: "test",
    timestamp: Date.now(),
  }) as AgentMessage;

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
});

/**
 * The text the provider actually receives. Summaries are custom-role messages,
 * so they only become text through `convertToLlm` — asserting on the converted
 * list is what proves the runtime has to pass that converter to the agent.
 */
function llmTexts(messages: AgentMessage[]) {
  return texts(convertToLlm(messages) as AgentMessage[]);
}

function texts(messages: AgentMessage[]) {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => (part as { text?: string }).text ?? "")
      .join("")
      .trim();
  });
}

let sessions = new Sessions(databasePath, sandbox);

await check("a new conversation starts with an empty tree", async () => {
  const entries = await sessions.entries("conv-a");
  assert(entries.length === 0, `${entries.length} entries in a fresh conversation`);
  const context = await sessions.context("conv-a");
  assert(context.messages.length === 0, "a fresh conversation projected messages");
  return "no entries, no context";
});

await check("messages append in order and project back as themselves", async () => {
  const session = await sessions.session("conv-a");
  await session.appendMessage(user("第一个问题"));
  await session.appendMessage(assistant("第一个回答"));
  await session.appendMessage(user("第二个问题"));

  const entries = await sessions.entries("conv-a");
  assert(entries.length === 3, `${entries.length} entries`);
  assert(entries.every((entry) => entry.type === "message"), "non-message entry appeared");
  const seqs = entries.map((entry) => entry.seq);
  assert(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!), `entries out of order: ${seqs}`);

  const context = await sessions.context("conv-a");
  assert(
    JSON.stringify(texts(context.messages)) === JSON.stringify(["第一个问题", "第一个回答", "第二个问题"]),
    `context was ${JSON.stringify(texts(context.messages))}`,
  );
  return "3 messages, branch order preserved";
});

await check("the tree survives closing and reopening the store", async () => {
  await sessions.close();
  sessions = new Sessions(databasePath, sandbox);
  const entries = await sessions.entries("conv-a");
  assert(entries.length === 3, `${entries.length} entries after reopen`);
  assert(fs.existsSync(databasePath), "no database file on disk");
  return `reopened with ${entries.length} entries`;
});

await check("a compaction entry hides earlier history from the model, not from the tree", async () => {
  const session = await sessions.session("conv-a");
  const before = await sessions.entries("conv-a");

  await session.appendEntry(
    {
      type: "compaction",
      id: session.idGenerator.next(),
      summary: "前面聊了两轮，用户在问 A 和 B。",
      retainedTail: [user("第二个问题")],
      tokensBefore: 4321,
    },
    LANE,
  );
  await session.appendMessage(assistant("压缩之后的回答"));

  const context = await sessions.context("conv-a");
  const projected = llmTexts(context.messages);
  assert(
    projected.some((text) => text.includes("前面聊了两轮")),
    `the summary never reaches the model: ${JSON.stringify(projected)}`,
  );
  assert(
    projected.some((text) => text.includes("<summary>")),
    "the summary reached the model without the wrapper that tells it what the text is",
  );
  assert(
    !projected.includes("第一个回答"),
    `history before the compaction still reaches the model: ${JSON.stringify(projected)}`,
  );
  assert(projected.at(-1) === "压缩之后的回答", `the newest turn was dropped: ${JSON.stringify(projected)}`);

  const entries = await sessions.entries("conv-a");
  assert(entries.length === before.length + 2, `${entries.length} entries after compaction`);
  assert(
    entries.some((entry) => entry.type === "message" && texts([entry.message])[0] === "第一个回答"),
    "the tree lost the compacted history, so the reader cannot scroll back to it",
  );
  return `context ${context.messages.length} messages, tree ${entries.length} entries`;
});

await check("rewinding the lane drops a turn from the branch but keeps it in the tree", async () => {
  const session = await sessions.session("conv-b");
  await session.appendMessage(user("保留这条"));
  const keep = await session.getLeafId();
  await session.appendMessage(assistant("这条会被回退"));
  assert((await sessions.entries("conv-b")).length === 2, "setup failed");

  await sessions.rewind("conv-b", keep);
  const branch = await sessions.entries("conv-b");
  assert(branch.length === 1, `${branch.length} entries on the branch after the rewind`);
  assert(texts([(branch[0] as { message: AgentMessage }).message])[0] === "保留这条", "the wrong entry survived");

  const session2 = await sessions.session("conv-b");
  const all = await session2.findEntries({ order: "oldestFirst" });
  assert(all.length === 2, `the abandoned turn was deleted instead of parked (${all.length} entries session-wide)`);

  // A new turn continues from the rewound point, which is what regenerate does.
  await session2.appendMessage(assistant("重新生成的回答"));
  const after = texts((await sessions.context("conv-b")).messages);
  assert(
    JSON.stringify(after) === JSON.stringify(["保留这条", "重新生成的回答"]),
    `branch after regenerate was ${JSON.stringify(after)}`,
  );
  return "branch rewound, old turn still recoverable";
});

await check("usage records accumulate into per-conversation token and cost totals", async () => {
  const session = await sessions.session("conv-c");
  const entryId = await session.appendMessage(assistant("算钱"));
  await session.appendRecord({
    type: "usage",
    id: session.idGenerator.next(),
    lane: LANE,
    usage: usage(1000, 200),
    cause: "assistant",
    runId: "run-1",
    entryId,
    attempt: 1,
    stopReason: "stop",
  });
  await session.appendRecord({
    type: "usage",
    id: session.idGenerator.next(),
    lane: LANE,
    usage: usage(500, 100),
    cause: "assistant",
    runId: "run-2",
    entryId,
    attempt: 1,
    stopReason: "stop",
  });

  const stats = await sessions.stats("conv-c");
  assert(stats.totalTokens === 1800, `totalTokens ${stats.totalTokens}`);
  assert(Math.abs(stats.costTotal - 0.06) < 1e-9, `costTotal ${stats.costTotal}`);
  assert(stats.messageCount === 1, `messageCount ${stats.messageCount}`);
  return `${stats.totalTokens} tokens, cost ${stats.costTotal.toFixed(4)}`;
});

await check("conversations are isolated from each other", async () => {
  const a = texts((await sessions.context("conv-a")).messages);
  const b = texts((await sessions.context("conv-b")).messages);
  assert(!b.some((text) => a.includes(text)), `conversations bled into each other: ${JSON.stringify({ a, b })}`);
  return "separate trees";
});

await check("forgetting a conversation removes its tree", async () => {
  await sessions.forget("conv-c");
  const entries = await sessions.entries("conv-c");
  assert(entries.length === 0, `${entries.length} entries survived the delete`);
  return "tree dropped and re-created empty";
});

// ------------------------------------------------- transcript projection

const store = new Store(new Db(path.join(sandbox, "luma.sqlite")));

/** The transcript a client would fetch, as plain text. */
function transcript(conversationId: string) {
  return store.storedMessages(conversationId).map((row) => texts([row.content as AgentMessage])[0]);
}

await check("a conversation written before the tree is adopted into it", async () => {
  const conversation = store.createConversation("test-model");
  store.addMessage(conversation.id, user("老的问题"));
  store.addMessage(conversation.id, assistant("老的回答"));

  const adopted = await adoptTranscript(store, sessions, conversation.id);
  assert(adopted === 2, `adopted ${adopted}`);

  const context = llmTexts((await sessions.context(conversation.id)).messages);
  assert(
    JSON.stringify(context) === JSON.stringify(["老的问题", "老的回答"]),
    `the model would have seen ${JSON.stringify(context)}`,
  );
  // Every row now points at the entry it came from, which is what a rewind needs.
  for (const row of store.storedMessages(conversation.id)) {
    assert(store.messageEntryId(conversation.id, row.seq), `row ${row.seq} was adopted without an entry`);
  }

  const again = await adoptTranscript(store, sessions, conversation.id);
  assert(again === 0, "a second adoption duplicated the history");
  return "2 messages adopted, and adoption is idempotent";
});

await check("the transcript re-derives from the tree", async () => {
  const conversation = store.createConversation("test-model");
  const session = await sessions.session(conversation.id);
  await session.appendMessage(user("一"));
  await session.appendMessage(assistant("二"));

  const projected = await projectTranscript(store, sessions, conversation.id);
  assert(projected === 2, `projected ${projected}`);
  assert(JSON.stringify(transcript(conversation.id)) === JSON.stringify(["一", "二"]), "wrong transcript");

  // Rebuilding is idempotent: it replaces rather than appends.
  await projectTranscript(store, sessions, conversation.id);
  assert(store.messageCount(conversation.id) === 2, `${store.messageCount(conversation.id)} rows after a rebuild`);
  return "2 rows, rebuilt in place";
});

await check("editing a turn rewinds the model and the reader to the same point", async () => {
  const conversation = store.createConversation("test-model");
  const session = await sessions.session(conversation.id);
  await session.appendMessage(user("第一个问题"));
  await session.appendMessage(assistant("第一个回答"));
  await session.appendMessage(user("要改掉的问题"));
  await session.appendMessage(assistant("基于错误问题的回答"));
  await projectTranscript(store, sessions, conversation.id);

  // The client asks to replace the message at sequence 2.
  await rewindConversation(store, sessions, conversation.id, 2);

  const reader = transcript(conversation.id);
  const model = llmTexts((await sessions.context(conversation.id)).messages);
  assert(
    JSON.stringify(reader) === JSON.stringify(["第一个问题", "第一个回答"]),
    `the reader still sees ${JSON.stringify(reader)}`,
  );
  assert(
    JSON.stringify(model) === JSON.stringify(reader),
    `the model sees something different from the reader: ${JSON.stringify(model)}`,
  );
  assert((await session.findEntries()).length === 4, "the abandoned turn was deleted instead of parked");
  assert(store.messageCount(conversation.id) === 2, "sequences were not renumbered for the client");
  return "both truncated to 2, tree kept all 4";
});

await check("search finds a message and points at where it is in the transcript", async () => {
  const conversation = store.createConversation("test-model");
  const session = await sessions.session(conversation.id);
  await session.appendMessage(user("帮我写一个关于潮汕牛肉丸的段子"));
  await session.appendMessage(assistant("牛肉丸弹起来能砸破玻璃杯，这是真事。"));
  await projectTranscript(store, sessions, conversation.id);

  const hits = await searchConversations(store, sessions, "潮汕牛肉丸", 10);
  const hit = hits.find((row) => row.conversationId === conversation.id);
  assert(hit, `no hit for a message that is definitely there: ${JSON.stringify(hits)}`);
  assert(hit!.seq === 0, `hit points at seq ${hit!.seq}`);
  assert(hit!.role === "user", `hit role was ${hit!.role}`);
  assert(hit!.snippet.includes("潮汕牛肉丸"), `snippet lost the match: ${hit!.snippet}`);
  // A CJK query has no word breaks, which is why the index is a trigram one.
  const partial = await searchConversations(store, sessions, "牛肉丸弹起来", 10);
  assert(
    partial.some((row) => row.conversationId === conversation.id && row.seq === 1),
    "a substring query did not reach the assistant's answer",
  );
  return `${hits.length} hit(s), snippet "${hit!.snippet.slice(0, 24)}…"`;
});

await check("search does not offer a turn the reader cannot scroll to", async () => {
  const conversation = store.createConversation("test-model");
  const session = await sessions.session(conversation.id);
  await session.appendMessage(user("保留的问题"));
  const keep = await session.getLeafId();
  await session.appendMessage(assistant("这条回答提到了独角鲸"));
  await projectTranscript(store, sessions, conversation.id);
  assert((await searchConversations(store, sessions, "独角鲸", 10)).length === 1, "setup failed");

  // The turn is abandoned, so it stays in the tree and leaves the projection.
  await sessions.rewind(conversation.id, keep);
  await projectTranscript(store, sessions, conversation.id);

  const hits = await searchConversations(store, sessions, "独角鲸", 10);
  assert(hits.length === 0, `an abandoned turn was offered as a result: ${JSON.stringify(hits)}`);
  assert(
    (await session.findEntries()).some((entry) => entry.type === "message"),
    "the audit deleted the entry instead of abandoning it, so it proves nothing",
  );
  return "hit withheld while the entry stays in the tree";
});

await check("search is scoped to text, not to the payload's structure", async () => {
  // "role" and "timestamp" are JSON keys in every entry payload. A search that
  // reached the raw payload would answer with the whole database.
  const noise = await searchConversations(store, sessions, "timestamp", 10);
  assert(noise.length === 0, `${noise.length} hit(s) from matching the payload's own JSON keys`);
  const empty = await searchConversations(store, sessions, "   ", 10);
  assert(empty.length === 0, "a blank query returned results");
  return "JSON keys and blank queries return nothing";
});

await check("editing the first message empties the conversation", async () => {
  const conversation = store.createConversation("test-model");
  const session = await sessions.session(conversation.id);
  await session.appendMessage(user("唯一的问题"));
  await session.appendMessage(assistant("唯一的回答"));
  await projectTranscript(store, sessions, conversation.id);

  await rewindConversation(store, sessions, conversation.id, 0);
  assert(store.messageCount(conversation.id) === 0, "rows survived a rewind to the start");
  assert((await sessions.entries(conversation.id)).length === 0, "the branch survived a rewind to the start");
  return "branch and transcript both empty";
});

store.db.close();
await sessions.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : `\nall session checks passed`);
process.exit(failures ? 1 : 0);
