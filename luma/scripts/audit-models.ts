/**
 * Real per-model probe: one short streamed run per configured chat model, plus
 * a forced tool call, asserting on SSE frames and the persisted transcript.
 * Test conversations are deleted afterwards.
 *
 *   node --import tsx scripts/audit-models.ts [modelId]
 */
import { isChatKind } from "@shared/types.ts";

const BASE = process.env.LUMA_BASE ?? "http://127.0.0.1:8090/v1";
const onlyModel = process.argv[2] ?? "";

const code = process.env.LUMA_ACCESS_CODE;
if (!code) throw new Error("set LUMA_ACCESS_CODE to the access code of the instance under test");

let token = "";

async function call<T = any>(method: string, endpoint: string, body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as T };
  } catch {
    return { status: response.status, body: { raw: text.slice(0, 300) } as T };
  }
}

interface Trace {
  deltas: number;
  text: string;
  finalText: string;
  thinking: number;
  tools: Array<{ id: string; name: string; intent?: string; ok?: boolean; resultChars?: number }>;
  title: string;
  terminal: string;
  frames: string[];
  firstDeltaMs: number;
  totalMs: number;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: any) => (p?.type === "text" ? String(p.text ?? "") : "")).join("")
      : "";

async function stream(runId: string, after: number): Promise<Trace> {
  const started = Date.now();
  const trace: Trace = {
    deltas: 0, text: "", finalText: "", thinking: 0, tools: [], title: "",
    terminal: "", frames: [], firstDeltaMs: 0, totalMs: 0,
  };
  const response = await fetch(`${BASE}/runs/${runId}/events?after=${after}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const type = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const raw = lines.find((l) => l.startsWith("data: "))?.slice(6);
      if (!type) continue;
      if (trace.frames.length < 6) trace.frames.push(frame.slice(0, 220));
      if (!raw) continue;
      const event = JSON.parse(raw) as { seq: number; type: string; data: any };
      const data = event.data ?? {};
      if (type === "message.delta") {
        trace.deltas += 1;
        if (!trace.firstDeltaMs) trace.firstDeltaMs = Date.now() - started;
        const inner = data.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (inner?.type === "text_delta" && inner.delta) trace.text += inner.delta;
        if (inner?.type === "thinking_delta") trace.thinking += 1;
      }
      if (type === "message.end" && data.message?.role === "assistant") {
        trace.finalText += textOf(data.message.content);
      }
      if (type === "tool.execution.start") {
        trace.tools.push({ id: String(data.toolCallId), name: String(data.toolName), intent: data.args?.intent });
      }
      if (type === "tool.execution.end") {
        const entry = trace.tools.find((t) => t.id === String(data.toolCallId));
        if (entry) {
          entry.ok = !data.isError;
          entry.resultChars = JSON.stringify(data.result ?? "").length;
        }
      }
      if (type === "conversation.title") trace.title = String(data.title);
      if (type.startsWith("run.") && type !== "run.started") {
        trace.terminal = `${type}${data.message ? `: ${String(data.message).slice(0, 220)}` : ""}`;
      }
    }
  }
  trace.totalMs = Date.now() - started;
  return trace;
}

const login = await call<{ token: string }>("POST", "/auth/token", { accessCode: code, deviceName: "audit-models" });
token = login.body.token;
if (!token) throw new Error("login failed");

const boot = await call<any>("GET", "/bootstrap");
const models = boot.body.models.filter(
  (m: any) => m.enabled && m.configured && isChatKind(m.kind) && (!onlyModel || m.id === onlyModel),
);

const rows: Array<Record<string, unknown>> = [];

for (const model of models) {
  const label = `${model.id} (${model.apiMode})`;
  const created = await call<{ id: string }>("POST", "/conversations", { modelId: model.id });
  const conversationId = created.body.id;
  try {
    // 1. plain streamed answer + title
    const run = await call<{ runId: string; seq: number }>("POST", `/conversations/${conversationId}/runs`, {
      text: "只回答两个字：你好。不要调用任何工具。",
      modelId: model.id,
    });
    if (run.status !== 202) throw new Error(`run rejected ${run.status}: ${JSON.stringify(run.body).slice(0, 200)}`);
    const trace = await stream(run.body.runId, run.body.seq);

    // 2. forced multi-turn tool call in the same conversation
    const toolRun = await call<{ runId: string; seq: number }>("POST", `/conversations/${conversationId}/runs`, {
      text: "用 list_directory 工具看一下 luma 目录下有什么，然后一句话总结。必须调用工具。",
      modelId: model.id,
    });
    const toolTrace = toolRun.status === 202 ? await stream(toolRun.body.runId, toolRun.body.seq) : null;

    const stored = await call<{ items: any[] }>("GET", `/conversations/${conversationId}/messages`);
    const roles = stored.body.items.map((m: any) => m.role).join(",");
    const hasBase64 = JSON.stringify(stored.body).includes('"data":"iVBOR');

    rows.push({
      model: label,
      terminal: trace.terminal,
      deltas: trace.deltas,
      chars: trace.text.length,
      finalChars: trace.finalText.length,
      deltaMatchesFinal: trace.finalText.includes(trace.text.trim().slice(0, 20)),
      thinkingDeltas: trace.thinking,
      ttfbMs: trace.firstDeltaMs,
      totalMs: trace.totalMs,
      title: trace.title,
      toolTerminal: toolTrace?.terminal ?? "(skipped)",
      toolsCalled: toolTrace?.tools.map((t) => `${t.name}${t.ok === false ? "!" : ""}`).join("+") || "none",
      toolIntent: toolTrace?.tools[0]?.intent?.slice(0, 40) ?? "",
      toolIdsUnique: toolTrace ? new Set(toolTrace.tools.map((t) => t.id)).size === toolTrace.tools.length : true,
      roles,
      base64Leak: hasBase64,
    });
    console.log(`done ${label}: ${trace.terminal} / tools ${rows.at(-1)!.toolsCalled}`);
  } catch (error) {
    rows.push({ model: label, terminal: `THREW: ${error instanceof Error ? error.message : String(error)}` });
    console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await call("DELETE", `/conversations/${conversationId}`);
  }
}

console.log("\n=== MODEL MATRIX ===");
console.log(JSON.stringify(rows, null, 2));
