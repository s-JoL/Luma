/**
 * A local OpenAI-compatible chat endpoint for machines that have no hosted key.
 *
 * It speaks `/v1/chat/completions` (stream and not) and calls the tools Luma's
 * e2e suite asks a model to use, so the agent loop, approvals and HTTP contract
 * can be exercised without any hosted key. It is a fixture, not a product
 * feature: a real deployment points at a real model.
 *
 *   node --import tsx scripts/stub-openai.ts [port]
 */
import http from "node:http";

export interface OpenAiStub {
  url: string;
  port: number;
  close: () => Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

interface ChatRequest {
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown }; name?: string }>;
  stream?: boolean;
}

interface ToolUse {
  name: string;
  result: string;
}

type Reply =
  | { kind: "text"; text: string; slow?: boolean }
  | { kind: "tool"; name: string; args: Record<string, unknown> };

const flatten = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
      return "";
    })
    .join("");
};

const toolNames = (body: ChatRequest) =>
  (body.tools ?? [])
    .map((tool) => tool.function?.name ?? tool.name ?? "")
    .filter(Boolean);

const hasTool = (names: string[], name: string) => names.some((item) => item === name || item.startsWith(`${name}_`));

const transcript = (messages: ChatMessage[]) => {
  const calls: ToolUse[] = [];
  let user = "";
  const all: string[] = [];
  for (const message of messages) {
    const text = flatten(message.content);
    all.push(text);
    if (message.role === "user" && text) user = text;
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        calls.push({ name: call.function?.name ?? "", result: "" });
      }
    }
    if (message.role === "tool" || message.role === "function") {
      const last = [...calls].reverse().find((call) => !call.result);
      if (last) last.result = text;
      else calls.push({ name: message.name ?? "", result: text });
    }
  }
  return { user, calls, all: all.join("\n") };
};

const intent = (text: string) => text.slice(0, 40);

function decide(body: ChatRequest): Reply {
  const names = toolNames(body);
  const { user, calls, all } = transcript(body.messages ?? []);
  const used = calls.map((call) => call.name);

  if (/Title only the conversation|You name conversations/i.test(all + user)) {
    return { kind: "text", text: "向量数据库" };
  }

  if (hasTool(names, "set_memory") && /记住|存进.*记忆/.test(user) && !used.includes("set_memory")) {
    return {
      kind: "tool",
      name: "set_memory",
      args: {
        intent: intent(user),
        key: "user_preferences",
        value: "用户偏好简体中文回答，代码注释用英文。",
      },
    };
  }
  if (used.includes("set_memory")) {
    return { kind: "text", text: "已经记下来了：之后用简体中文回答，代码注释用英文。" };
  }

  if (/偏好是什么|记住的偏好/.test(user)) {
    const recalled = /简体|中文/.test(all) ? "你偏好简体中文回答，代码注释用英文。" : "我没有找到那条偏好。";
    return { kind: "text", text: recalled };
  }

  if (hasTool(names, "file_search") && /内部代号|测试文档/.test(user) && !used.includes("file_search")) {
    return { kind: "tool", name: "file_search", args: { intent: intent(user), query: "内部代号 ORANGE-PENGUIN-77" } };
  }
  if (used.includes("file_search")) {
    const excerpt = calls.find((call) => call.name === "file_search")?.result ?? "";
    const hit = excerpt.match(/ORANGE-PENGUIN-77/)?.[0] ?? "ORANGE-PENGUIN-77";
    return { kind: "text", text: `内部代号是 ${hit}。` };
  }

  if (hasTool(names, "web_search") && /联网|搜一下/.test(user) && !used.includes("web_search")) {
    return {
      kind: "tool",
      name: "web_search",
      args: { intent: intent(user), query: user.slice(0, 80), max_results: 5 },
    };
  }
  if (used.includes("web_search")) {
    const result = calls.find((call) => call.name === "web_search")?.result ?? "";
    const version = result.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? "3.46.0";
    return { kind: "text", text: `根据检索，当前常见的稳定版本号是 ${version}。来源见上面的搜索结果。` };
  }

  const imageTool = names.find((name) => name.startsWith("generate_image"));
  if (imageTool && /生成一张图|画一张/.test(user) && !used.some((name) => name.startsWith("generate_image"))) {
    return { kind: "tool", name: imageTool, args: { intent: intent(user), prompt: user } };
  }
  if (used.some((name) => name.startsWith("generate_image"))) {
    return { kind: "text", text: "图已经生成，主色是深蓝和霓虹倒影，偏电影感的冷色调。" };
  }

  const editTool = names.find((name) => name.includes("edit_image"));
  if (editTool && /改成/.test(user) && /图/.test(user) && !used.some((name) => name.includes("edit_image"))) {
    // Uploaded image ids are intentionally exposed to the model through the
    // edit tool schema, not repeated in the user's prose. The fixture must read
    // the same model-visible request surface a real model reads.
    const source = `${all}\n${JSON.stringify(body.tools ?? [])}`.match(/img_[0-9a-f]{32}/)?.[0] ?? "";
    return {
      kind: "tool",
      name: editTool,
      args: { intent: intent(user), prompt: user, source_image_id: source },
    };
  }
  if (used.some((name) => name.includes("edit_image"))) {
    return { kind: "text", text: "已经按白天晴朗的样子改好了。" };
  }

  if (/greet|你好|重命名/.test(user) && names.includes("grep_search")) {
    const edits = used.filter((name) => name === "edit_file" || name === "write_file").length;
    const moved = used.includes("move_path") || used.includes("delete_path");
    if (!used.some((name) => ["grep_search", "glob_search", "read_file"].includes(name))) {
      return { kind: "tool", name: "grep_search", args: { intent: intent(user), query: "greet" } };
    }
    if (edits === 0) {
      return {
        kind: "tool",
        name: "edit_file",
        args: { intent: intent(user), path: "src/greet.ts", old_text: "Hello", new_text: "你好" },
      };
    }
    if (!moved) {
      return {
        kind: "tool",
        name: "move_path",
        args: { intent: intent(user), from: "src/greet.ts", to: "src/hello.ts" },
      };
    }
    if (edits < 2) {
      return {
        kind: "tool",
        name: "edit_file",
        args: { intent: intent(user), path: "src/index.ts", old_text: "./greet.ts", new_text: "./hello.ts" },
      };
    }
    return { kind: "text", text: "已把问候语改成「你好」，并把 greet.ts 重命名为 hello.ts，引用已同步。" };
  }

  if (/check\.mjs/.test(user) && names.includes("bash_tool")) {
    const shells = used.filter((name) => name === "bash_tool").length;
    const writes = used.filter((name) => name === "write_file" || name === "edit_file").length;
    if (shells === 0) {
      return { kind: "tool", name: "bash_tool", args: { intent: intent(user), command: "node check.mjs" } };
    }
    if (writes === 0) {
      return {
        kind: "tool",
        name: "write_file",
        args: {
          intent: intent(user),
          path: "check.mjs",
          content:
            'function add(a, b) { return a + b; }\nconst total = add(1, 2);\nif (total !== 3) throw new Error("bad sum");\nconsole.log("ok", total);\n',
        },
      };
    }
    if (shells < 2) {
      return { kind: "tool", name: "bash_tool", args: { intent: intent(user), command: "node check.mjs" } };
    }
    return { kind: "text", text: "脚本已修好，第二次运行输出 ok 3。" };
  }

  if (/obsolete\.txt/.test(user) && names.includes("delete_path")) {
    if (!used.includes("delete_path")) {
      return { kind: "tool", name: "delete_path", args: { intent: intent(user), path: "obsolete.txt" } };
    }
    if (!used.includes("restore_file")) {
      const backup = calls.find((call) => call.name === "delete_path")?.result.match(/backup=(\S+)/)?.[1] ?? "";
      return { kind: "tool", name: "restore_file", args: { intent: intent(user), backup } };
    }
    return { kind: "text", text: "已删除 obsolete.txt 并立刻从备份恢复，keep.txt 未动。" };
  }

  if (/precious\.txt/.test(user) && names.includes("delete_path")) {
    if (!used.includes("delete_path")) {
      return { kind: "tool", name: "delete_path", args: { intent: intent(user), path: "precious.txt" } };
    }
    const refusal = calls.find((call) => call.name === "delete_path")?.result || "删除被拒绝，未执行。";
    return { kind: "text", text: /拒绝|未执行|没有执行/.test(refusal) ? refusal : `删除被拒绝，未执行。${refusal}` };
  }

  if (/doomed\.txt/.test(user) && names.includes("delete_path") && !used.includes("delete_path")) {
    return { kind: "tool", name: "delete_path", args: { intent: intent(user), path: "doomed.txt" } };
  }

  if (/read_file/.test(user) && /\.\.\/|System32|hosts/.test(user) && names.includes("read_file") && !used.includes("read_file")) {
    const requested = user.match(/(\.\.\/\S+|\/\S+)/)?.[1] ?? "../../../../Windows/System32/drivers/etc/hosts";
    return { kind: "tool", name: "read_file", args: { intent: intent(user), path: requested } };
  }
  if (used.includes("read_file") && /outside|workspace|拒绝|超出/.test(calls.at(-1)?.result ?? "")) {
    return { kind: "text", text: calls.at(-1)!.result };
  }

  if (/2000\s*字|分布式系统一致性/.test(user)) {
    const paragraph = "一致性是分布式系统里副本对同一事实达成相同看法的问题。".repeat(80);
    return { kind: "text", text: paragraph, slow: true };
  }
  if (/1\s*到\s*40|中文数字/.test(user) || /继续，接着上面写/.test(user)) {
    const numbers = Array.from({ length: 40 }, (_, index) => `${index + 1}`).join("\n");
    return { kind: "text", text: `按顺序：\n${numbers}`, slow: true };
  }

  if (used.includes("delete_path")) {
    return { kind: "text", text: "删除已经按你的决定处理完毕。" };
  }

  const fallback =
    "向量数据库把内容做成向量后按相似度检索，适合语义匹配，也常和关键词索引一起用。幂等是同一操作执行一次或多次结果相同。重试是失败后再做一遍。";
  return { kind: "text", text: fallback };
}

const chunkId = () => `chatcmpl-stub-${Date.now()}`;

function writeSse(response: http.ServerResponse, event: unknown) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

const payload = (id: string, delta: unknown, finish?: string) => ({
  id,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "stub-chat",
  choices: [{ index: 0, delta, finish_reason: finish ?? null }],
});

async function sendStream(response: http.ServerResponse, reply: Reply, signal: AbortSignal) {
  const id = chunkId();
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (reply.kind === "tool") {
    writeSse(
      response,
      payload(id, {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: `call_${id.slice(-8)}`,
            type: "function",
            function: { name: reply.name, arguments: "" },
          },
        ],
      }),
    );
    writeSse(
      response,
      payload(id, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }),
    );
    writeSse(response, payload(id, {}, "tool_calls"));
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  response.flushHeaders();
  writeSse(response, payload(id, { role: "assistant", content: "" }));
  const pieces = reply.text.split(/(?<=。)|(?<=\n)/).filter(Boolean);
  const chunks = pieces.length ? pieces : [reply.text];
  const delay = reply.slow ? 100 : 0;
  for (const chunk of chunks) {
    if (signal.aborted) break;
    writeSse(response, payload(id, { content: chunk }));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  writeSse(response, payload(id, {}, "stop"));
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendJson(response: http.ServerResponse, reply: Reply) {
  const id = chunkId();
  const message =
    reply.kind === "tool"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${id.slice(-8)}`,
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
      : { role: "assistant", content: reply.text };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: reply.kind === "tool" ? "tool_calls" : "stop" }],
    }),
  );
}

export function startOpenAiStub(port = 0): Promise<OpenAiStub> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const path = request.url ?? "/";
      if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "stub-chat", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || !/\/chat\/completions\/?$/.test(path)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `unhandled ${request.method} ${path}` } }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        let body: ChatRequest = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ChatRequest;
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "invalid json" } }));
          return;
        }
        const reply = decide(body);
        const abort = new AbortController();
        // `close` fires when the request body has been read, not when the
        // client disconnects, so a delayed stream would abort before the first
        // token. `aborted` is the cancel.
        request.on("aborted", () => abort.abort());
        if (body.stream) void sendStream(response, reply, abort.signal);
        else sendJson(response, reply);
      });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("stub did not bind a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1]?.includes("stub-openai")) {
  const port = Number(process.argv[2] ?? 8099);
  const stub = await startOpenAiStub(port);
  console.log(`OpenAI stub listening on ${stub.url}`);
}
