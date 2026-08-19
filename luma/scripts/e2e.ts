/**
 * End-to-end acceptance run against a live server. Every check asserts on the
 * HTTP contract or the stored state, so a green run means the API is usable by
 * a real client, not just that the process stayed up.
 *
 * It creates and deletes real conversations, so it defaults to the audit
 * instance from `audit-db.ts --clone` (port 8095, `data-audit`, AUDITCODE)
 * rather than to the live server on 8090.
 *
 *   node --import tsx scripts/e2e.ts [only-substring]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.LUMA_BASE ?? "http://127.0.0.1:8095/v1";
const CODE = process.env.LUMA_ACCESS_CODE ?? "AUDITCODE";
const only = process.argv[2] ?? "";

/** Handoff between checks that build on each other. */
const carry: { fileId?: string; conversationId?: string; imageId?: string; phrase?: string } = {};

let token = "";

interface Reply<T> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  method: string,
  endpoint: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as T, headers: response.headers };
  } catch {
    return { status: response.status, body: { raw: text } as T, headers: response.headers };
  }
}

async function upload(name: string, mime: string, bytes: Buffer) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type: mime }));
  const response = await fetch(`${BASE}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: response.status, body: (await response.json()) as { id: string; name: string } };
}

interface RunTrace {
  /** Text assembled from live deltas. */
  text: string;
  /** Text a reconnecting client would recover from persisted `message.end`. */
  finalText: string;
  tools: Array<{ name: string; intent?: string; isError?: boolean }>;
  /** Every destructive call the server stopped to ask about, and how it ended. */
  approvals: Array<{ id: string; action: string; summary: string; status: string }>;
  title: string;
  finished: string;
  events: number;
}

/**
 * Stands in for the person at the keyboard. There is no policy that lets a run
 * proceed unattended, so a test that triggers the gate has to answer it, which
 * is also what exercises the real decide endpoint.
 */
type ApprovalPolicy = "approve" | "reject" | "ignore";

/** Assistant content is either a plain string or an array of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("");
}

async function stream(runId: string, after: number, policy: ApprovalPolicy = "approve"): Promise<RunTrace> {
  const response = await fetch(`${BASE}/runs/${runId}/events?after=${after}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.body) throw new Error("no stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const trace: RunTrace = {
    text: "",
    finalText: "",
    tools: [],
    approvals: [],
    title: "",
    finished: "",
    events: 0,
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const raw = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (!type || !raw) continue;
      trace.events += 1;
      const data = (JSON.parse(raw) as { data?: Record<string, unknown> }).data ?? {};
      if (type === "message.delta") {
        const event = data.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (event?.type === "text_delta" && event.delta) trace.text += event.delta;
      }
      if (type === "message.end") {
        const message = data.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant") trace.finalText += textOf(message.content);
      }
      if (type === "tool.execution.start") {
        trace.tools.push({
          name: String(data.toolName),
          intent: (data.args as { intent?: string } | undefined)?.intent,
        });
      }
      if (type === "tool.execution.end") {
        const entry = trace.tools.findLast((tool) => tool.name === data.toolName);
        if (entry) entry.isError = Boolean(data.isError);
      }
      if (type === "tool.approval.required" || type === "tool.approval.resolved") {
        const approval = data.approval as { id: string; action: string; summary: string; status: string };
        const seen = trace.approvals.find((item) => item.id === approval.id);
        if (seen) seen.status = approval.status;
        else trace.approvals.push({ ...approval });
        // Answered from outside the read loop: blocking here would stop
        // draining the very stream the decision is supposed to unblock.
        if (type === "tool.approval.required" && policy !== "ignore") {
          void call("POST", `/approvals/${approval.id}`, { approved: policy === "approve" });
        }
      }

      if (type === "conversation.title") trace.title = String(data.title);
      if (type.startsWith("run.") && type !== "run.started") {
        trace.finished = `${type}${data.message ? `: ${String(data.message).slice(0, 200)}` : ""}`;
      }
    }
  }
  return trace;
}

async function converse(
  prompt: string,
  options: { conversationId?: string; attachments?: string[]; approvals?: ApprovalPolicy } = {},
) {
  let conversationId = options.conversationId;
  if (!conversationId) {
    const created = await call<{ id: string }>("POST", "/conversations", {});
    conversationId = created.body.id;
  }
  const run = await call<{ runId: string; seq: number }>("POST", `/conversations/${conversationId}/runs`, {
    text: prompt,
    attachments: options.attachments,
  });
  if (run.status !== 202) throw new Error(`run rejected ${run.status}: ${JSON.stringify(run.body)}`);
  const trace = await stream(run.body.runId, run.body.seq, options.approvals ?? "approve");
  return { conversationId, runId: run.body.runId, ...trace };
}

interface ModelRow {
  id: string;
  kind?: string;
  ops?: string[];
  enabled: boolean;
  configured: boolean;
}

interface JobRow {
  id: string;
  status: string;
  progress: number | null;
  note: string | null;
  error: string | null;
  assets: Array<{ assetId: string; kind: string; mime: string }>;
}

/** A row written before `kind` existed is a chat model, same as the server reads it. */
const kindOf = (model: ModelRow) => model.kind ?? "chat";

async function generationModel(): Promise<ModelRow> {
  const catalogue = await call<{ items: ModelRow[] }>("GET", "/models");
  const model = catalogue.body.items.find(
    (item) => item.enabled && item.configured && kindOf(item) === "image" && item.ops?.includes("text_to_image"),
  );
  assert(model, "no configured image model to queue a job with");
  return model;
}

/**
 * A conversation of at least two turns, with a phrase in it that search can
 * look for. The image checks leave one behind and it is reused when they did,
 * because a transcript with a picture in it is the harder case; but paging and
 * search are about the HTTP contract and the index, not about whether the model
 * decided to reach for a tool, so they must not fail when it did not.
 */
async function transcript(): Promise<{ conversationId: string; phrase: string }> {
  if (carry.conversationId && carry.phrase) {
    return { conversationId: carry.conversationId, phrase: carry.phrase };
  }
  const phrase = "不要再生成新图";
  const first = await converse("用一句话说明什么是幂等。");
  assert(first.finished === "run.completed", first.finished);
  const second = await converse(`再用一句话说明什么是重试。顺便说明：${phrase}。`, {
    conversationId: first.conversationId,
  });
  assert(second.finished === "run.completed", second.finished);
  carry.conversationId = first.conversationId;
  carry.phrase = phrase;
  return { conversationId: first.conversationId, phrase };
}

/**
 * Reads a job's stream to its settled frame. Every frame is the whole row, so
 * the frames are collected rather than folded: what a client sees over time is
 * exactly this list.
 */
async function watchJob(id: string): Promise<JobRow[]> {
  const response = await fetch(`${BASE}/jobs/${id}/events`, { headers: { authorization: `Bearer ${token}` } });
  assert(response.status === 200, `job stream status ${response.status}`);
  assert(response.body, "no job stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: JobRow[] = [];
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const raw = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
      if (!event.startsWith("job.") || !raw) continue;
      frames.push(JSON.parse(raw) as JobRow);
    }
  }
  return frames;
}

const results: Array<{ name: string; ok: boolean; detail: string; ms: number }> = [];

async function check(name: string, fn: () => Promise<string>) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  process.stdout.write(`… ${name}`);
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, detail, ms });
    process.stdout.write(`\r\x1b[32mPASS\x1b[0m ${name} — ${detail} (${(ms / 1000).toFixed(1)}s)\n`);
  } catch (error) {
    const ms = Date.now() - started;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail, ms });
    process.stdout.write(`\r\x1b[31mFAIL\x1b[0m ${name} — ${detail} (${(ms / 1000).toFixed(1)}s)\n`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- setup

const anonymous = await fetch(`${BASE}/bootstrap`);
assert(anonymous.status === 401, `unauthenticated bootstrap should be 401, got ${anonymous.status}`);

const badLogin = await call("POST", "/auth/token", { accessCode: "definitely-wrong", deviceName: "e2e" });
assert(badLogin.status === 401, `bad access code should be 401, got ${badLogin.status}`);

const login = await call<{ token: string }>("POST", "/auth/token", { accessCode: CODE, deviceName: "e2e" });
token = login.body.token ?? "";
assert(token, `login failed: ${JSON.stringify(login.body)}`);

// Credentials normally live in the vault already; the environment is only an
// override for a fresh machine. Whatever the source, report what the server
// ended up with, since a missing key turns later checks into false failures.
if (process.env.VENICE_API_KEY) await call("PUT", "/providers/venice/key", { value: process.env.VENICE_API_KEY });
if (process.env.COMETAPI_KEY) await call("PUT", "/providers/cometapi/key", { value: process.env.COMETAPI_KEY });
if (process.env.TAVILY_API_KEY) {
  await call("PUT", "/capabilities/secrets/tavily", { value: process.env.TAVILY_API_KEY });
}
if (process.env.EMBEDDING_API_KEY) {
  await call("PUT", "/capabilities/secrets/embedding", { value: process.env.EMBEDDING_API_KEY });
}

const configured = await call<{
  providers: { id: string; hasKey: boolean }[];
  capabilities: { web: { hasTavilyKey: boolean }; embedding: { hasKey: boolean } };
}>("GET", "/bootstrap");
const providerKey = (id: string) => configured.body.providers?.find((p) => p.id === id)?.hasKey ?? false;
const hasTavily = configured.body.capabilities.web.hasTavilyKey;
const hasEmbedding = configured.body.capabilities.embedding.hasKey;

console.log(
  `auth ok — venice:${providerKey("venice") ? "yes" : "no"} cometapi:${providerKey("cometapi") ? "yes" : "no"} ` +
    `tavily:${hasTavily ? "yes" : "no"} embedding:${hasEmbedding ? "yes" : "no"}\n`,
);

// ---------------------------------------------------------------- checks

await check("bootstrap exposes what a cold client needs", async () => {
  const reply = await call<{
    models: Array<{ id: string; configured: boolean; kind: string; ops: string[] }>;
    capabilities: {
      memory: { enabled: boolean };
      web: { enabled: boolean; hasTavilyKey: boolean };
      embedding: { hasKey: boolean };
    };
    mcp: Array<{ id: string; enabled: boolean; connected: boolean }>;
    profiles: Array<{ id: string }>;
    defaultModelId: string;
  }>("GET", "/bootstrap");
  assert(reply.status === 200, `status ${reply.status}`);
  const configured = reply.body.models.filter((model) => model.configured);
  assert(configured.length > 0, "no configured model");
  assert(reply.body.defaultModelId, "no default model");
  assert(
    configured.some((model) => model.kind === "chat"),
    "nothing to hold a conversation with",
  );
  // Drawing is first-party now, so a deployment with no MCP server at all is a
  // complete one — what has to exist is a model that can draw.
  assert(
    configured.some((model) => model.kind === "image" && model.ops.includes("text_to_image")),
    "no image model, so the studio and the image tools would both be empty",
  );
  assert(Array.isArray(reply.body.mcp), "mcp status missing");
  assert(Array.isArray(reply.body.profiles), "profiles missing");
  assert(reply.body.capabilities.memory && reply.body.capabilities.web, "capabilities missing");
  assert(reply.body.capabilities.web.hasTavilyKey === hasTavily, "tavily key flag not reported consistently");
  assert(reply.body.capabilities.embedding.hasKey === hasEmbedding, "embedding key flag not reported consistently");
  const drawable = configured.filter((model) => model.kind !== "chat").length;
  return `${configured.length} configured, ${drawable} of them generative, ${reply.body.mcp.length} mcp`;
});

await check("secrets never leave the server", async () => {
  const reply = await call<Array<{ id: string; hasKey: boolean; apiKey?: string }>>("GET", "/providers");
  const provider = reply.body.find((item) => item.id === "venice");
  assert(provider, "venice provider missing");
  assert(provider.hasKey === true, "hasKey flag not set after storing key");
  assert(!("apiKey" in provider), "provider response carries an apiKey field");

  const capabilities = await call("GET", "/capabilities");
  const capabilityJson = JSON.stringify(capabilities.body);

  // Structural masking is what the API guarantees; when a key happens to be in
  // the environment we can also prove the literal value never comes back.
  for (const [label, secret] of [
    ["venice", process.env.VENICE_API_KEY],
    ["tavily", process.env.TAVILY_API_KEY],
    ["embedding", process.env.EMBEDDING_API_KEY],
  ] as const) {
    if (!secret) continue;
    assert(!JSON.stringify(reply.body).includes(secret), `${label} key echoed by /providers`);
    assert(!capabilityJson.includes(secret), `${label} key echoed by /capabilities`);
  }
  return "keys masked, hasKey exposed";
});

await check("plain chat streams text and generates a title", async () => {
  const run = await converse("用两句话解释什么是向量数据库。");
  assert(run.finished === "run.completed", run.finished);
  assert(run.text.length > 20, `short answer: ${run.text.length} chars`);
  assert(run.title, "no title event");
  const stored = await call<{ items: Array<{ role: string }> }>(
    "GET",
    `/conversations/${run.conversationId}/messages`,
  );
  assert(stored.body.items.length >= 2, `stored ${stored.body.items.length} messages`);
  return `${run.text.length} chars, title "${run.title}"`;
});

await check("memory tool writes through to /memory", async () => {
  // Writing is a toggle, and an instance that has it off registers no
  // `set_memory` tool at all — which would fail this check for a reason that
  // has nothing to do with the tool. So it is switched on and put back.
  const before = await call<{ memory: { writeEnabled: boolean } }>("GET", "/capabilities");
  const wasOff = !before.body.memory.writeEnabled;
  if (wasOff) await call("PATCH", "/capabilities", { memory: { writeEnabled: true } });
  try {
    const key = "user_preferences";
    await call("DELETE", `/memory/${key}`);
    const run = await converse("请记住：我偏好简体中文回答，代码注释用英文。存进你的记忆里。");
    assert(run.finished === "run.completed", run.finished);
    const used = run.tools.find((tool) => tool.name === "set_memory");
    assert(used, `set_memory not called (tools: ${run.tools.map((t) => t.name).join(",") || "none"})`);
    assert(!used.isError, "set_memory reported an error");
    const memory = await call<{ items: Array<{ key: string; value: string }>; tokens: number }>("GET", "/memory");
    assert(memory.body.items.length > 0, "memory list empty after set_memory");
    return `${memory.body.items.length} keys, ${memory.body.tokens} tokens`;
  } finally {
    if (wasOff) await call("PATCH", "/capabilities", { memory: { writeEnabled: false } });
  }
});

await check("memory is injected into the next conversation", async () => {
  const run = await converse("我之前让你记住的偏好是什么？直接复述，不要调用工具。");
  assert(run.finished === "run.completed", run.finished);
  assert(/中文|简体/.test(run.text), `memory not recalled: ${run.text.slice(0, 120)}`);
  return "recalled from system prompt";
});

await check("file upload indexes and is searchable", async () => {
  const body = [
    "# Luma 内部测试文档",
    "",
    "## 部署",
    "Luma 服务默认监听 8090 端口，数据保存在 data/luma.db。",
    "",
    "## 秘钥",
    "主密钥文件名为 master.key，使用 AES-256-GCM 加密所有 provider 密钥。",
    "",
    "## 检索",
    "检索采用 SQLite 中的 Float32 向量暴力余弦相似度，配合 FTS5 trigram 关键词召回，用 RRF 融合。",
    "",
    "## 彩蛋",
    "内部代号是 ORANGE-PENGUIN-77。",
  ].join("\n");
  // 201 the first time this suite runs against a data directory, 200 on every
  // run after: the library is content-addressed, so the same document uploaded
  // twice is one entry rather than two copies of the same bytes.
  const uploaded = await upload("luma-test-doc.md", "text/markdown", Buffer.from(body, "utf8"));
  assert(uploaded.status === 201 || uploaded.status === 200, `upload status ${uploaded.status}`);

  const again = await upload("luma-test-doc-copy.md", "text/markdown", Buffer.from(body, "utf8"));
  assert(again.status === 200, `re-upload status ${again.status}`);
  assert(again.body.id === uploaded.body.id, `re-upload made a second entry: ${again.body.id}`);

  // Indexing is fire-and-forget and shares the embedding endpoint with the rest
  // of the suite, so the wait is sized for a rate-limited round trip, not for
  // the two seconds it takes when the endpoint is idle.
  let file: { embeddingStatus?: string; embeddingError?: string | null; chunkCount?: number } = {};
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const reply = await call<{ embeddingStatus: string; embeddingError: string | null; chunkCount: number }>(
      "GET",
      `/files/${uploaded.body.id}`,
    );
    file = reply.body;
    assert(!("diskPath" in file), "server disk path exposed to the client");
    if (file.embeddingStatus === "ready" || file.embeddingStatus === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(
    file.embeddingStatus === "ready",
    `embedding status ${file.embeddingStatus}${file.embeddingError ? `: ${file.embeddingError}` : ""}`,
  );
  assert((file.chunkCount ?? 0) > 0, "no chunks recorded");

  const search = await call<{
    mode: string;
    results: Array<{ excerpt: string; name: string; matchType: string }>;
  }>("POST", "/files/search", { query: "内部代号是什么", limit: 5 });
  assert(search.status === 200, `search status ${search.status}`);
  assert(search.body.results.length > 0, "no retrieval hits");
  assert(
    search.body.results.some((hit) => hit.excerpt.includes("ORANGE-PENGUIN-77")),
    `target chunk not retrieved (got: ${search.body.results.map((hit) => hit.excerpt.slice(0, 24)).join(" | ")})`,
  );

  // Short CJK queries fall below the FTS5 trigram floor and must hit the
  // LIKE fallback rather than returning nothing.
  const shortQuery = await call<{ results: Array<{ excerpt: string }> }>("POST", "/files/search", {
    query: "彩蛋",
    mode: "keyword",
    limit: 5,
  });
  assert(shortQuery.body.results.length > 0, "short CJK keyword query returned nothing");
  carry.fileId = uploaded.body.id;
  return `${file.chunkCount} chunks, ${search.body.results.length} hits`;
});

await check("file_search tool answers from the uploaded document", async () => {
  const run = await converse("查一下内部测试文档里写的内部代号是什么？");
  assert(run.finished === "run.completed", run.finished);
  const used = run.tools.find((tool) => tool.name === "file_search");
  assert(used, `file_search not called (tools: ${run.tools.map((t) => t.name).join(",") || "none"})`);
  assert(!used.isError, "file_search reported an error");
  assert(run.text.includes("ORANGE-PENGUIN-77"), `answer missed the fact: ${run.text.slice(0, 160)}`);
  return "cited the indexed chunk";
});

await check("web_search returns live results with citations", async () => {
  assert(hasTavily, "no tavily key configured on the server");

  // Both capabilities this check depends on are set rather than assumed. Web is
  // the obvious one. Coding matters too, and less obviously: an earlier suite
  // that left the workspace tools switched on gives the model a plausible wrong
  // answer to "look this up", and it reaches for grep_search. Leaving that to
  // chance turns a real regression signal into a coin flip.
  const snapshot = await call<{
    web: { enabled: boolean };
    coding: { read: boolean; write: boolean; shell: boolean; workspace: string };
  }>("GET", "/capabilities");
  const original = { web: snapshot.body.web.enabled, coding: snapshot.body.coding };
  const searchOnly = { read: false, write: false, shell: false, workspace: original.coding.workspace };
  await call("PATCH", "/capabilities", { web: { enabled: true }, coding: searchOnly });
  try {
    const run = await converse("联网查一下今天 SQLite 的最新稳定版本号是多少？给出来源。");
    assert(run.finished === "run.completed", run.finished);
    const used = run.tools.find((tool) => tool.name === "web_search");
    assert(used, `web_search not called (tools: ${run.tools.map((t) => t.name).join(",") || "none"})`);
    assert(!used.isError, "web_search reported an error");
    assert(/\d+\.\d+/.test(run.text), "no version-looking string in answer");
    return `intent: ${used.intent ?? "(none)"}`;
  } finally {
    await call("PATCH", "/capabilities", { web: { enabled: original.web }, coding: original.coding });
  }
});

await check("image generation returns a servable image_ref", async () => {
  const run = await converse("生成一张图：雨后的城市街道，霓虹倒影，夜晚，电影感。");
  assert(run.finished === "run.completed", run.finished);
  const used = run.tools.find((tool) => tool.name.startsWith("generate_image"));
  assert(used, `image tool not called (tools: ${run.tools.map((t) => t.name).join(",") || "none"})`);
  assert(!used.isError, "image tool reported an error");

  // The picture has to be in the transcript, not in the model's prose. It is
  // asked to embed the reference and usually does, but a turn where it only
  // described the picture still has to show one, so the id is read from the
  // stored tool result — which is where the client reads it from too.
  const messages = await call<{ items: unknown[] }>("GET", `/conversations/${run.conversationId}/messages`);
  const serialized = JSON.stringify(messages.body);
  assert(!serialized.includes('"data":"iVBOR'), "base64 leaked into the stored transcript");
  const imageId = serialized.match(/"image_id":"(img_[0-9a-f]{32})"/)?.[1] ?? "";
  assert(imageId, "no image_ref in the stored transcript");

  const image = await fetch(`${BASE}/images/${imageId}`, { headers: { authorization: `Bearer ${token}` } });
  assert(image.status === 200, `image fetch status ${image.status}`);
  const bytes = Buffer.from(await image.arrayBuffer());
  assert(bytes.byteLength > 10_000, `image too small: ${bytes.byteLength} bytes`);
  assert(String(image.headers.get("content-type")).startsWith("image/"), "wrong content-type");

  carry.conversationId = run.conversationId;
  carry.imageId = imageId;
  const inlined = run.text.includes(`image://${imageId}`);
  return `${Math.round(bytes.byteLength / 1024)} KB from ${imageId.slice(0, 12)}…, ${inlined ? "inlined by the model" : "shown from the tool result"}`;
});

await check("second turn sees the generated image", async () => {
  const { conversationId } = carry;
  assert(conversationId, "no conversation from the image check");
  const run = await converse("刚才那张图里主要是什么颜色调？一句话描述，不要再生成新图。", { conversationId });
  assert(run.finished === "run.completed", run.finished);
  assert(run.text.length > 5, "empty follow-up answer");
  assert(!run.tools.some((tool) => tool.name.startsWith("generate_image")), "regenerated instead of describing");
  // This transcript now has two turns and a phrase in it, which is what the
  // paging and search checks need.
  carry.phrase = "不要再生成新图";
  return run.text.replace(/\s+/g, " ").slice(0, 60);
});

await check("uploaded image can be edited", async () => {
  const { imageId } = carry;
  assert(imageId, "no image id from the generation check");
  const image = await fetch(`${BASE}/images/${imageId}`, { headers: { authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await image.arrayBuffer());
  const uploaded = await upload("edit-source.png", "image/png", bytes);
  assert(uploaded.status === 201, `upload status ${uploaded.status}`);

  const run = await converse("把这张图改成白天晴朗的样子。", { attachments: [uploaded.body.id] });
  assert(run.finished === "run.completed", run.finished);
  const used = run.tools.find((tool) => tool.name.includes("edit_image"));
  assert(
    used,
    `edit tool not called (tools: ${run.tools.map((t) => t.name).join(",") || "none"}); the model said: ${run.finalText.slice(0, 300)}`,
  );
  assert(!used.isError, "edit tool reported an error");

  const messages = await call<{ items: unknown[] }>("GET", `/conversations/${run.conversationId}/messages`);
  const produced = [...JSON.stringify(messages.body).matchAll(/"image_id":"(img_[0-9a-f]{32})"/g)].map(
    (match) => match[1]!,
  );
  // Neither the picture that was edited nor the copy that was uploaded as its
  // source counts; only something the edit itself minted does.
  const fresh = produced.find((id) => id !== imageId && id !== uploaded.body.id);
  assert(fresh, `no new image in the transcript (only saw ${produced.join(", ") || "none"})`);
  const edited = await fetch(`${BASE}/images/${fresh}`, { headers: { authorization: `Bearer ${token}` } });
  assert(edited.status === 200, `edited image fetch status ${edited.status}`);
  return `edit produced ${fresh.slice(0, 12)}…`;
});

await check("polling fallback mirrors the SSE stream", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const run = await call<{ runId: string; seq: number }>("POST", `/conversations/${created.body.id}/runs`, {
    text: "说出三种常见的排序算法，只列名字。",
  });
  assert(run.status === 202, `run status ${run.status}`);
  let cursor = run.body.seq;
  let done = false;
  let text = "";
  let finalText = "";
  let terminal = "";
  let rounds = 0;
  while (!done && rounds < 60) {
    rounds += 1;
    const page = await call<{
      events: Array<{ seq: number; type: string; data: Record<string, unknown> }>;
      done: boolean;
    }>("GET", `/runs/${run.body.runId}/events?mode=poll&after=${cursor}`);
    assert(page.status === 200, `poll status ${page.status}: ${JSON.stringify(page.body).slice(0, 200)}`);
    for (const event of page.body.events) {
      cursor = Math.max(cursor, event.seq);
      if (event.type === "message.delta") {
        const inner = event.data.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (inner?.type === "text_delta" && inner.delta) text += inner.delta;
      }
      if (event.type === "message.end") {
        const message = event.data.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant") finalText += textOf(message.content);
      }
      if (event.type.startsWith("run.") && event.type !== "run.started") {
        terminal = `${event.type}${event.data.message ? `: ${String(event.data.message).slice(0, 200)}` : ""}`;
        done = true;
      }
    }
    if (page.body.done) done = true;
  }
  assert(done, "poll loop never saw a terminal event");
  assert(terminal === "run.completed", `terminal event was ${terminal || "(none)"}`);
  assert(text.length > 5, `poll saw no incremental text (${text.length} streamed, ${finalText.length} final)`);
  assert(finalText.length > 5, `poll recovered no final text (${finalText.length} chars)`);
  return `${rounds} polls, ${text.length} streamed / ${finalText.length} final chars`;
});

await check("resuming a stream replays missed events", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const run = await call<{ runId: string; seq: number }>("POST", `/conversations/${created.body.id}/runs`, {
    text: "用一句话说明什么是幂等。",
  });
  assert(run.status === 202, `run status ${run.status}`);
  // Attach only after the run has settled. Deltas are pruned at that point, so
  // a late client must still be able to rebuild the answer from message.end.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await call<{ status: string }>("GET", `/runs/${run.body.runId}`);
    if (["completed", "failed", "cancelled"].includes(status.body.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const trace = await stream(run.body.runId, run.body.seq);
  assert(trace.finished === "run.completed", trace.finished);
  assert(trace.finalText.length > 5, `replay produced ${trace.finalText.length} chars`);
  return `${trace.events} events replayed, ${trace.finalText.length} chars recovered`;
});

await check("idempotency-key prevents duplicate runs", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const key = `e2e-${Date.now()}`;
  const first = await call<{ runId: string }>(
    "POST",
    `/conversations/${created.body.id}/runs`,
    { text: "数到三。" },
    { "idempotency-key": key },
  );
  const second = await call<{ runId: string }>(
    "POST",
    `/conversations/${created.body.id}/runs`,
    { text: "数到三。" },
    { "idempotency-key": key },
  );
  assert(first.status === 202 && second.status === 202, `${first.status}/${second.status}`);
  assert(first.body.runId === second.body.runId, "replay started a second run");
  await stream(first.body.runId, 0);
  return `single run ${first.body.runId.slice(0, 12)}…`;
});

await check("stop cancels an in-flight run", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const run = await call<{ runId: string; seq: number }>("POST", `/conversations/${created.body.id}/runs`, {
    text: "写一篇 2000 字的关于分布式系统一致性的长文。",
  });
  assert(run.status === 202, `run status ${run.status}`);
  const tracePromise = stream(run.body.runId, run.body.seq);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const stop = await call("POST", `/conversations/${created.body.id}/stop`);
  assert(stop.status === 204, `stop status ${stop.status}`);
  const trace = await tracePromise;
  assert(trace.finished.startsWith("run.cancelled"), `expected cancellation, got ${trace.finished}`);
  const status = await call<{ status: string }>("GET", `/runs/${run.body.runId}`);
  assert(status.body.status === "cancelled", `run row says ${status.body.status}`);
  return "stream closed and run marked cancelled";
});

await check("editing a message rewrites history from that turn", async () => {
  const first = await converse("我最喜欢的水果是芒果。请只回答“记住了”。");
  assert(first.finished === "run.completed", first.finished);
  const before = await call<{ items: Array<{ seq: number; role: string }> }>(
    "GET",
    `/conversations/${first.conversationId}/messages`,
  );
  const userSeq = before.body.items.find((item) => item.role === "user")!.seq;

  const rerun = await call<{ runId: string; seq: number }>("POST", `/conversations/${first.conversationId}/runs`, {
    text: "我最喜欢的水果是荔枝。请只回答“记住了”。",
    fromSeq: userSeq,
  });
  assert(rerun.status === 202, `edit run status ${rerun.status}`);
  const trace = await stream(rerun.body.runId, rerun.body.seq);
  assert(trace.finished === "run.completed", trace.finished);

  const after = await call<{ items: Array<{ seq: number; role: string; content: unknown }> }>(
    "GET",
    `/conversations/${first.conversationId}/messages`,
  );
  const users = after.body.items.filter((item) => item.role === "user");
  assert(users.length === 1, `expected the edit to replace the turn, found ${users.length} user messages`);
  const text = JSON.stringify(users[0]!.content);
  assert(text.includes("荔枝") && !text.includes("芒果"), "the replaced text is still the old one");
  await call("DELETE", `/conversations/${first.conversationId}`);
  return `turn ${userSeq} replaced, ${after.body.items.length} messages remain`;
});

await check("regenerating replays the same turn", async () => {
  const first = await converse("用一句话描述海。");
  assert(first.finished === "run.completed", first.finished);
  const log = await call<{ items: Array<{ seq: number; role: string }> }>(
    "GET",
    `/conversations/${first.conversationId}/messages`,
  );
  const userSeq = log.body.items.find((item) => item.role === "user")!.seq;

  const again = await call<{ runId: string; seq: number }>("POST", `/conversations/${first.conversationId}/runs`, {
    text: "用一句话描述海。",
    fromSeq: userSeq,
  });
  const trace = await stream(again.body.runId, again.body.seq);
  assert(trace.finished === "run.completed", trace.finished);
  assert(trace.finalText.length > 2, "regenerated answer is empty");

  const after = await call<{ items: Array<{ role: string }> }>(
    "GET",
    `/conversations/${first.conversationId}/messages`,
  );
  assert(
    after.body.items.filter((item) => item.role === "user").length === 1,
    "regenerate left a duplicate user message",
  );
  await call("DELETE", `/conversations/${first.conversationId}`);
  return `answer regenerated, ${trace.finalText.length} chars`;
});

await check("continue resumes a stopped answer", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const run = await call<{ runId: string; seq: number }>("POST", `/conversations/${created.body.id}/runs`, {
    text: "按顺序写出 1 到 40 的中文数字，每行一个。",
  });
  const tracePromise = stream(run.body.runId, run.body.seq);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await call("POST", `/conversations/${created.body.id}/stop`);
  await tracePromise;

  const stopped = await call<{ items: Array<{ role: string; content: { stopReason?: string } }> }>(
    "GET",
    `/conversations/${created.body.id}/messages`,
  );
  const partial = stopped.body.items.at(-1)!;
  assert(partial.role === "assistant" && partial.content.stopReason === "aborted", "no partial answer was kept");

  const resumed = await call<{ runId: string; seq: number }>("POST", `/conversations/${created.body.id}/continue`);
  assert(resumed.status === 202, `continue status ${resumed.status}`);
  const trace = await stream(resumed.body.runId, resumed.body.seq);
  assert(trace.finished === "run.completed", trace.finished);
  assert(trace.finalText.length > 2, "continuation produced nothing");

  // The partial answer has to survive: continuing must extend the thread, not
  // replace what was already on screen.
  const log = await call<{ items: Array<{ role: string }> }>("GET", `/conversations/${created.body.id}/messages`);
  assert(log.body.items.length > stopped.body.items.length, "continue did not add to the transcript");
  await call("DELETE", `/conversations/${created.body.id}`);
  return `resumed with ${trace.finalText.length} chars on top of the partial answer`;
});

await check("continue rejects an empty conversation", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const resumed = await call<{ code: string }>("POST", `/conversations/${created.body.id}/continue`);
  assert(resumed.status === 400, `expected 400, got ${resumed.status}`);
  await call("DELETE", `/conversations/${created.body.id}`);
  return "rejected with 400";
});

await check("settings changes take effect on the next run", async () => {
  const before = await call<{ capabilities: { web: { enabled: boolean } } }>("GET", "/bootstrap");
  const original = before.body.capabilities.web.enabled;
  const off = await call("PATCH", "/capabilities", { web: { enabled: false } });
  assert(off.status === 200, `patch status ${off.status}`);
  const run = await converse("联网搜一下今天的天气。");
  assert(run.finished === "run.completed", run.finished);
  assert(!run.tools.some((tool) => tool.name === "web_search"), "web_search still registered after disabling");
  const back = await call<{ web: { enabled: boolean } }>("PATCH", "/capabilities", { web: { enabled: original } });
  assert(back.status === 200, `restore status ${back.status}`);
  assert(back.body.web.enabled === original, `web capability left as ${back.body.web.enabled}, wanted ${original}`);
  return "capability toggle honoured, restored afterwards";
});

await check("a profile pins its chat model and gates its tools", async () => {
  const catalogue = await call<{ items: ModelRow[]; defaultModelId: string }>("GET", "/models");
  const chat = catalogue.body.items.filter((model) => model.enabled && model.configured && kindOf(model) === "chat");
  assert(chat.length, "no chat model to pin");
  // A model other than the global default, when there is one, so pinning is
  // visible rather than a coincidence.
  const pinned = chat.find((model) => model.id !== catalogue.body.defaultModelId) ?? chat[0]!;

  const created = await call<{ id: string; chatModelId: string }>("POST", "/profiles", {
    name: `E2E 无工具 ${Date.now()}`,
    chatModelId: pinned.id,
    capabilities: { memory: false, files: false, web: false, coding: false, skills: false, generation: false },
  });
  assert(created.status === 201, `profile create status ${created.status}`);
  const profileId = created.body.id;

  try {
    const conversation = await call<{ id: string; modelId: string; profileId: string }>("POST", "/conversations", {
      profileId,
    });
    assert(conversation.status === 201 || conversation.status === 200, `conversation status ${conversation.status}`);
    assert(conversation.body.profileId === profileId, `profile not stored: ${conversation.body.profileId}`);
    assert(conversation.body.modelId === pinned.id, `model ${conversation.body.modelId}, wanted ${pinned.id}`);

    // Generation is off in this profile, so the tool is not registered at all
    // and asking for a picture cannot reach it.
    const run = await converse("画一张猫的图。", { conversationId: conversation.body.id });
    assert(run.finished === "run.completed", run.finished);
    const reached = run.tools.filter((tool) => /image|memory|web_search|file_search/.test(tool.name));
    assert(!reached.length, `gated tools still registered: ${reached.map((tool) => tool.name).join(",")}`);

    const cleared = await call<{ profileId: string }>("PATCH", `/conversations/${conversation.body.id}`, {
      profileId: "",
    });
    assert(cleared.body.profileId === "", `clearing the profile left ${cleared.body.profileId}`);
    await call("DELETE", `/conversations/${conversation.body.id}`);
    return `pinned ${pinned.id}, ${run.tools.length} tool calls, none of them gated`;
  } finally {
    await call("DELETE", `/profiles/${profileId}`);
  }
});

await check("the job queue streams a generation to completion", async () => {
  const model = await generationModel();
  const submitted = await call<JobRow>("POST", "/jobs", {
    modelId: model.id,
    op: "text_to_image",
    params: { prompt: "一只坐在窗台上的橘猫，柔和的晨光，胶片质感。" },
  });
  assert(submitted.status === 202, `submit status ${submitted.status}`);
  assert(submitted.body.status === "queued", `submitted as ${submitted.body.status}`);

  const frames = await watchJob(submitted.body.id);
  assert(frames.length, "the stream carried no frame");
  assert(frames[0]!.status === "queued" || frames[0]!.status === "running", `opened with ${frames[0]!.status}`);
  const settled = frames.at(-1)!;
  assert(settled.status === "succeeded", `finished as ${settled.status}: ${settled.error ?? ""}`);
  assert(frames.some((frame) => frame.status === "running"), "never reported running");

  const asset = settled.assets[0];
  assert(asset, "succeeded with no asset");
  assert(asset.kind === "image", `asset kind ${asset.kind}`);

  // The row answers a reconnect on its own, which is the whole reason the stream
  // carries no cursor.
  const reread = await call<JobRow>("GET", `/jobs/${submitted.body.id}`);
  assert(reread.body.status === "succeeded", `re-read says ${reread.body.status}`);
  assert(reread.body.assets[0]?.assetId === asset.assetId, "re-read lost the asset");

  const listed = await call<{ items: JobRow[] }>("GET", "/jobs?status=succeeded&limit=20");
  assert(listed.body.items.some((job) => job.id === submitted.body.id), "not listed under succeeded");

  const image = await fetch(`${BASE}/images/${asset.assetId}`, { headers: { authorization: `Bearer ${token}` } });
  assert(image.status === 200, `asset fetch status ${image.status}`);
  const progress = frames.filter((frame) => frame.progress !== null).length;
  return `${frames.length} frames, ${progress} with progress, ${asset.assetId.slice(0, 12)}… served`;
});

await check("a job can be cancelled", async () => {
  const model = await generationModel();
  const submitted = await call<JobRow>("POST", "/jobs", {
    modelId: model.id,
    op: "text_to_image",
    params: { prompt: "一片被雨淋湿的麦田。" },
  });
  assert(submitted.status === 202, `submit status ${submitted.status}`);
  const cancelled = await call<JobRow>("POST", `/jobs/${submitted.body.id}/cancel`);
  assert(cancelled.status === 200, `cancel status ${cancelled.status}`);
  assert(cancelled.body.status === "cancelled", `cancel left it ${cancelled.body.status}`);
  assert(!cancelled.body.assets.length, "a cancelled job produced an asset");
  // Cancelling twice is how a client that lost its answer retries, so it must
  // not become an error.
  const again = await call<JobRow>("POST", `/jobs/${submitted.body.id}/cancel`);
  assert(again.body.status === "cancelled", `second cancel returned ${again.body.status}`);
  return "cancelled, no asset, idempotent";
});

/**
 * Coding runs against a throwaway workspace rather than the real one, so a
 * model that misreads the instruction cannot touch anything that matters.
 */
interface CodingCapability {
  read: boolean;
  write: boolean;
  shell: boolean;
  workspace: string;
}

/**
 * The real configuration, read once. Reading it per check instead would carry a
 * previous *interrupted* run's temp directory forward as the thing to restore,
 * and the server would be left pointed at a directory that no longer exists.
 */
let realCoding: CodingCapability | undefined;

async function withCodingWorkspace<T>(seed: (dir: string) => void, fn: (dir: string) => Promise<T>) {
  if (!realCoding) {
    const snapshot = await call<{ coding: CodingCapability }>("GET", "/capabilities");
    const stored = snapshot.body.coding;
    realCoding = fs.existsSync(stored.workspace)
      ? stored
      : { ...stored, workspace: path.resolve(process.cwd(), "..") };
  }
  const original = realCoding;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "luma-e2e-code-"));
  seed(workspace);
  const patched = await call("PATCH", "/capabilities", {
    coding: { read: true, write: true, shell: true, workspace },
  });
  assert(patched.status === 200, `enabling coding returned ${patched.status}`);
  try {
    return await fn(workspace);
  } finally {
    // Leaving the server pointed at a temp directory that is about to be
    // deleted breaks every later coding check with a confusing "path is
    // outside the workspace", so the restore is verified rather than assumed.
    const restored = await call<{ coding: { workspace: string } }>("PATCH", "/capabilities", { coding: original });
    if (restored.body?.coding?.workspace !== original.workspace) {
      console.warn(
        `\n!! coding workspace not restored: wanted ${original.workspace}, server has ${restored.body?.coding?.workspace}`,
      );
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

await check("agent searches, patches and renames across files", async () => {
  return withCodingWorkspace(
    (dir) => {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(
        path.join(dir, "src", "greet.ts"),
        "export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n",
      );
      fs.writeFileSync(path.join(dir, "src", "index.ts"), 'import { greet } from "./greet.ts";\nconsole.log(greet("world"));\n');
    },
    async (dir) => {
      const run = await converse(
        "这是一个 TypeScript 小工程。请先检索代码找到 greet 函数，把返回的问候语从 Hello 改成 你好，" +
          "再把 src/greet.ts 重命名为 src/hello.ts，并同步更新所有引用它的地方。完成后用一句话说明你改了什么。",
      );
      assert(run.finished === "run.completed", run.finished);

      const used = run.tools.map((tool) => tool.name);
      assert(used.some((name) => ["grep_search", "glob_search", "read_file"].includes(name)), `no search step: ${used.join(",")}`);
      assert(used.includes("edit_file") || used.includes("write_file"), `no edit step: ${used.join(",")}`);
      // Renaming through move_path or through write-then-delete are both
      // correct; asserting on the route would make this a test of one model's
      // taste rather than of the workspace ending up in the right shape. A
      // mid-run failure is allowed for the same reason: an edit whose `old_text`
      // does not match is exactly the refusal the write path is designed to give,
      // and recovering from it is the behaviour we want. What may not happen is
      // ending the run on a failure.
      assert(!run.tools.at(-1)?.isError, `the run ended on a failed call: ${used.join(",")}`);

      // On the rare run that stops half way, what the model *said* is the whole
      // diagnosis: a model that reported a rename it never performed is a
      // different defect from one that gave up and said so.
      const claim = `called ${used.join(",")} and said: ${run.finalText.replace(/\s+/g, " ").slice(0, 240)}`;
      assert(fs.existsSync(path.join(dir, "src", "hello.ts")), `src/hello.ts was not created; ${claim}`);
      assert(!fs.existsSync(path.join(dir, "src", "greet.ts")), `src/greet.ts was left behind; ${claim}`);
      const renamed = fs.readFileSync(path.join(dir, "src", "hello.ts"), "utf8");
      assert(renamed.includes("你好"), `greeting not changed: ${renamed}`);
      const caller = fs.readFileSync(path.join(dir, "src", "index.ts"), "utf8");
      assert(/hello\.ts/.test(caller), `import not updated: ${caller}`);
      const route = used.includes("move_path") ? "move_path" : "write + delete";
      return `${used.length} tool calls via ${route}: ${[...new Set(used)].join(", ")}`;
    },
  );
});

await check("agent runs a command, sees the failure and fixes it", async () => {
  return withCodingWorkspace(
    (dir) => {
      fs.writeFileSync(path.join(dir, "check.mjs"), 'const total = add(1, 2);\nif (total !== 3) throw new Error("bad sum");\nconsole.log("ok", total);\n');
    },
    async (dir) => {
      const run = await converse(
        `请在工作区里用命令 \`node check.mjs\` 运行这个脚本。它会报错。` +
          "请阅读报错信息，修好 check.mjs 让它成功输出 ok 3，然后再运行一次确认通过。",
      );
      assert(run.finished === "run.completed", run.finished);
      const shellCalls = run.tools.filter((tool) => tool.name === "bash_tool");
      assert(shellCalls.length >= 2, `expected a failing run and a re-run, saw ${shellCalls.length}`);
      assert(shellCalls.some((tool) => tool.isError), "the model never saw a failing command");
      assert(!shellCalls.at(-1)!.isError, "the final command still failed");
      const fixed = fs.readFileSync(path.join(dir, "check.mjs"), "utf8");
      assert(/function add|const add|add\s*=/.test(fixed), `add was never defined: ${fixed}`);
      return `${shellCalls.length} command runs, recovered from the first failure`;
    },
  );
});

await check("a delete waits for a person, and runs once approved", async () => {
  return withCodingWorkspace(
    (dir) => {
      fs.writeFileSync(path.join(dir, "obsolete.txt"), "delete me\n");
      fs.writeFileSync(path.join(dir, "keep.txt"), "keep me\n");
    },
    async (dir) => {
      const run = await converse("请删除工作区里的 obsolete.txt，保留 keep.txt。删除后立刻把 obsolete.txt 恢复回来。", {
        approvals: "approve",
      });
      assert(run.finished === "run.completed", run.finished);
      const used = run.tools.map((tool) => tool.name);
      const asked = run.approvals.find((item) => item.action === "delete");
      assert(asked, `the delete ran without asking anyone: ${JSON.stringify(run.approvals)}`);
      assert(asked.status === "approved", `approval settled as ${asked.status}`);
      assert(asked.summary.includes("obsolete.txt"), `the card did not name the file: ${asked.summary}`);
      assert(used.includes("delete_path"), `delete_path not called: ${used.join(",")}`);
      assert(used.includes("restore_file"), `restore_file not called: ${used.join(",")}`);
      assert(fs.existsSync(path.join(dir, "keep.txt")), "keep.txt was destroyed");
      assert(fs.existsSync(path.join(dir, "obsolete.txt")), "obsolete.txt was not restored");
      return `held for approval (${asked.action}), then deleted and restored from the backup`;
    },
  );
});

await check("rejecting a delete leaves the file and tells the model why", async () => {
  return withCodingWorkspace(
    (dir) => fs.writeFileSync(path.join(dir, "precious.txt"), "do not lose this\n"),
    async (dir) => {
      const run = await converse(
        "请删除工作区里的 precious.txt。如果删除失败或被拒绝，请把原因原样告诉我，不要重试，也不要用命令绕开。",
        { approvals: "reject" },
      );
      assert(run.finished === "run.completed", run.finished);
      const asked = run.approvals.find((item) => item.action === "delete");
      assert(asked, `no approval was requested: ${JSON.stringify(run.approvals)}`);
      assert(asked.status === "rejected", `approval settled as ${asked.status}`);
      assert(fs.existsSync(path.join(dir, "precious.txt")), "a rejected delete still destroyed the file");
      const attempt = run.tools.find((tool) => tool.name === "delete_path");
      assert(attempt?.isError, "the refusal did not reach the model as a failed tool result");
      assert(/拒绝|未执行|没有执行/.test(run.finalText), `the model never reported the refusal: ${run.finalText.slice(0, 200)}`);
      return "file intact, tool result is an error, model relayed the refusal";
    },
  );
});

await check("a pending question survives a reconnect and is answerable", async () => {
  return withCodingWorkspace(
    (dir) => fs.writeFileSync(path.join(dir, "doomed.txt"), "bye\n"),
    async (dir) => {
      const created = await call<{ id: string }>("POST", "/conversations", {});
      const conversationId = created.body.id;
      const started = await call<{ runId: string; seq: number }>("POST", `/conversations/${conversationId}/runs`, {
        text: "请删除工作区里的 doomed.txt。",
      });
      assert(started.status === 202, `run rejected ${started.status}`);

      // Nothing reads the stream: this is the client that was closed when the
      // question was asked, so the row has to be discoverable on its own.
      let listed: { id: string; action: string; summary: string; status: string } | undefined;
      for (let attempt = 0; attempt < 60 && !listed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const pending = await call<{ items: Array<{ id: string; action: string; summary: string; status: string }> }>(
          "GET",
          `/conversations/${conversationId}/approvals`,
        );
        listed = pending.body.items[0];
      }
      assert(listed, "a pending question was invisible to a client that reconnected");
      assert(listed.status === "pending", `listed as ${listed.status}`);
      assert(listed.summary.includes("doomed.txt"), `summary does not name the file: ${listed.summary}`);

      const decided = await call("POST", `/approvals/${listed.id}`, { approved: true });
      assert(decided.status === 200, `decide status ${decided.status}`);
      // A retry of the same POST must not be able to change the answer.
      const again = await call<{ status: string }>("POST", `/approvals/${listed.id}`, { approved: false });
      assert(again.body.status === "approved", `a retried POST flipped the decision to ${again.body.status}`);

      const trace = await stream(started.body.runId, started.body.seq, "approve");
      assert(trace.finished === "run.completed", trace.finished);
      assert(!fs.existsSync(path.join(dir, "doomed.txt")), "the approved delete never happened");
      return "answered with no stream open, decision replayed to the reattaching client";
    },
  );
});

await check("coding tools refuse to leave the workspace", async () => {
  return withCodingWorkspace(
    (dir) => fs.writeFileSync(path.join(dir, "inside.txt"), "fine\n"),
    async () => {
      const run = await converse(
        "请尝试用 read_file 读取路径 ../../../../Windows/System32/drivers/etc/hosts。如果被拒绝，直接把拒绝原因原样告诉我，不要重试其它路径。",
      );
      assert(run.finished === "run.completed", run.finished);
      const attempt = run.tools.find((tool) => tool.name === "read_file");
      assert(attempt, `read_file was never attempted: ${run.tools.map((t) => t.name).join(",") || "none"}`);
      assert(attempt.isError, "a path outside the workspace was read successfully");
      return "escape attempt rejected and reported to the model";
    },
  );
});

await check("messages page backwards from the end of a long transcript", async () => {
  const { conversationId } = await transcript();

  const all = await call<{ items: Array<{ seq: number; role: string }>; nextCursor: number | null }>(
    "GET",
    `/conversations/${conversationId}/messages`,
  );
  const total = all.body.items.length;
  assert(total >= 4, `need a few messages to page through, have ${total}`);
  assert(all.body.nextCursor === null, "the unpaged read should not claim there is more");

  // A client opening the conversation asks for the end, not the whole thing.
  const size = 2;
  const first = await call<{ items: Array<{ seq: number; role: string }>; nextCursor: number | null }>(
    "GET",
    `/conversations/${conversationId}/messages?limit=${size}`,
  );
  assert(first.body.items.length >= size, `first page held ${first.body.items.length}`);
  assert(
    first.body.items.at(-1)!.seq === all.body.items.at(-1)!.seq,
    "the first page is not anchored to the newest message",
  );

  // Walking the cursor must cover the transcript exactly once, in order.
  const seen: number[] = first.body.items.map((item) => item.seq);
  let cursor = first.body.nextCursor;
  for (let page = 0; page < 20 && cursor !== null; page += 1) {
    const next = await call<{ items: Array<{ seq: number }>; nextCursor: number | null }>(
      "GET",
      `/conversations/${conversationId}/messages?limit=${size}&before=${cursor}`,
    );
    assert(next.body.items.length, `page ${page} came back empty with cursor ${cursor}`);
    assert(next.body.items.at(-1)!.seq < seen[0]!, `page ${page} overlaps the page after it`);
    seen.unshift(...next.body.items.map((item) => item.seq));
    cursor = next.body.nextCursor;
  }
  assert(cursor === null, "paging did not reach the start of the conversation");
  assert(seen.length === total, `paging saw ${seen.length} messages, the transcript has ${total}`);
  assert(
    seen.every((seq, index) => index === 0 || seq > seen[index - 1]!),
    "pages are not in ascending order or contain duplicates",
  );
  assert(seen[0] === all.body.items[0]!.seq, "paging missed the first message");

  // A page starts where a turn starts, so a tool result never opens a page
  // with its call stranded on the page before it.
  assert(first.body.items[0]!.role === "user", `page opens on a ${first.body.items[0]!.role} message`);

  const bad = await call("GET", `/conversations/${conversationId}/messages?limit=0`);
  assert(bad.status === 400, `limit=0 should be rejected, got ${bad.status}`);
  return `${total} messages walked in pages of ${size}, cursor terminated cleanly`;
});

await check("search finds a message across conversations", async () => {
  // The phrase was sent verbatim in a user message, so a hit proves the index
  // covers what actually went into the tree.
  const { conversationId, phrase } = await transcript();
  const found = await call<{ items: Array<{ conversationId: string; seq: number; role: string; snippet: string }> }>(
    "GET",
    `/conversations/search?q=${encodeURIComponent(phrase)}`,
  );
  assert(found.status === 200, `search status ${found.status}`);
  const hit = found.body.items.find((item) => item.conversationId === conversationId);
  assert(hit, `no hit for a phrase that was definitely sent: ${JSON.stringify(found.body.items)}`);
  assert(hit!.role === "user", `hit role is ${hit!.role}`);
  assert(hit!.snippet.includes(phrase), `snippet lost the match: ${hit!.snippet}`);

  // The hit has to name a place a client can open.
  const messages = await call<{ items: Array<{ seq: number }> }>(
    "GET",
    `/conversations/${conversationId}/messages`,
  );
  assert(messages.body.items.some((item) => item.seq === hit!.seq), `seq ${hit!.seq} is not in the transcript`);

  const empty = await call<{ items: unknown[] }>("GET", "/conversations/search?q=%20");
  assert(empty.body.items.length === 0, "a blank query returned results");
  const miss = await call<{ items: unknown[] }>("GET", "/conversations/search?q=zzzznotinanyconversation");
  assert(miss.body.items.length === 0, "a query with no matches returned results");
  return `hit at seq ${hit!.seq}: ${hit!.snippet.slice(0, 28)}…`;
});

await check("failures answer in the documented envelope", async () => {
  // A client shows `message` verbatim and branches on `code`, so a route that
  // answers with a bare string or an empty body breaks it (`02-api.md
  // §Conventions`).
  const cases: Array<[string, string, number, unknown?]> = [
    ["GET", "/conversations/conv_missing", 404],
    ["POST", "/conversations/conv_missing/runs", 404, { text: "hi" }],
    ["GET", "/runs/run_missing", 404],
    ["GET", "/images/img_00000000000000000000000000000000", 404],
    ["GET", "/images/not-an-id", 400],
    ["GET", "/files/file_missing", 404],
    // Keys are free-form now, so a rejection has to be a real format violation
    // — a space and punctuation — rather than a name absent from a whitelist.
    ["PUT", "/memory/not%20a%20valid%20key%21", 400, { value: "x" }],
    ["GET", "/nope", 404],
  ];
  const wrong: string[] = [];
  for (const [method, endpoint, expected, body] of cases) {
    const reply = await call<{ error?: { code?: string; message?: string } }>(method, endpoint, body);
    const error = reply.body?.error;
    if (reply.status !== expected) wrong.push(`${method} ${endpoint} → ${reply.status}, wanted ${expected}`);
    else if (!error?.code || !error?.message) wrong.push(`${method} ${endpoint} → no envelope: ${JSON.stringify(reply.body).slice(0, 80)}`);
  }
  assert(!wrong.length, wrong.join("; "));

  const anonymous = await fetch(`${BASE}/conversations`);
  assert(anonymous.status === 401, `an unauthenticated read returned ${anonymous.status}`);
  const denied = (await anonymous.json()) as { error?: { code?: string } };
  assert(denied.error?.code, "401 carried no error code");
  return `${cases.length} failures plus an unauthenticated read, all enveloped`;
});

await check("conversation lifecycle: rename, list, delete", async () => {
  const created = await call<{ id: string }>("POST", "/conversations", {});
  const renamed = await call<{ title: string }>("PATCH", `/conversations/${created.body.id}`, { title: "改过的标题" });
  assert(renamed.body.title === "改过的标题", `title is ${renamed.body.title}`);
  const list = await call<{ items: Array<{ id: string }> }>("GET", "/conversations?limit=100");
  assert(list.body.items.some((item) => item.id === created.body.id), "conversation missing from list");
  const removed = await call("DELETE", `/conversations/${created.body.id}`);
  assert(removed.status === 204, `delete status ${removed.status}`);
  const gone = await call("GET", `/conversations/${created.body.id}`);
  assert(gone.status === 404, `deleted conversation still returns ${gone.status}`);
  return "create → rename → list → delete";
});

// ---------------------------------------------------------------- report

const failed = results.filter((result) => !result.ok);
const seconds = (results.reduce((total, result) => total + result.ms, 0) / 1000).toFixed(1);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${seconds}s`);
if (failed.length) {
  for (const result of failed) console.log(`  ✗ ${result.name}: ${result.detail}`);
  process.exit(1);
}
