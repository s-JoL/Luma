/**
 * Bisects which request field a provider rejects, by posting variants of the
 * same synthetic payload straight at the endpoint. Synthetic content only; the
 * key is read from the vault and never printed.
 *
 *   node --import tsx scripts/audit-bisect.ts <providerId> <wireModel>
 */
import { SECRET } from "../src/server/config.ts";
import { loadMasterKey, SecretVault } from "../src/server/crypto/secrets.ts";
import { paths } from "../src/server/env.ts";
import { Db } from "../src/server/store/db.ts";
import { Store } from "../src/server/store/store.ts";

const providerId = process.argv[2] ?? "cometapi";
const wireModel = process.argv[3] ?? "glm-5.3";

const store = new Store(new Db(paths.db));
const vault = new SecretVault(store, loadMasterKey(paths.masterKey));
const provider = store.getProvider(providerId)!;
const key = vault.get(SECRET.provider(providerId));
if (!key) throw new Error(`no key for ${providerId}`);

const base = () => ({
  model: wireModel,
  messages: [
    { role: "developer", content: "You are a helpful assistant. Answer in one short sentence." },
    { role: "user", content: [{ type: "text", text: "List the luma directory." }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_probe_1", type: "function", function: { name: "list_directory", arguments: '{"intent":"Listing luma","path":"luma"}' } },
      ],
    },
    { role: "tool", content: "dir   src\ndir   docs\nfile  package.json", tool_call_id: "call_probe_1" },
  ] as Array<Record<string, unknown>>,
  stream: true,
  stream_options: { include_usage: true },
  store: false,
  max_completion_tokens: 1024,
  tools: [
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List the immediate entries of a directory.",
        parameters: { type: "object", properties: { intent: { type: "string" }, path: { type: "string" } }, required: [] },
        strict: false,
      },
    },
  ],
  reasoning_effort: "high",
});

type Mutate = (body: Record<string, any>) => void;

const variants: Array<[string, Mutate]> = [
  ["baseline (exactly what Luma sends)", () => {}],
  ["developer → system", (b) => { b.messages[0].role = "system"; }],
  ["no reasoning_effort", (b) => { delete b.reasoning_effort; }],
  ["no store", (b) => { delete b.store; }],
  ["max_completion_tokens → max_tokens", (b) => { b.max_tokens = b.max_completion_tokens; delete b.max_completion_tokens; }],
  ["no stream_options", (b) => { delete b.stream_options; }],
  ["no strict on tool", (b) => { delete b.tools[0].function.strict; }],
  ["assistant content null → ''", (b) => { b.messages[2].content = ""; }],
  ["user content array → string", (b) => { b.messages[1].content = "List the luma directory."; }],
  ["no tools at all", (b) => { delete b.tools; }],
  ["drop tool turn entirely", (b) => { b.messages = b.messages.slice(0, 2); }],
  ["librechatCompat equivalent", (b) => {
    delete b.stream_options; delete b.store; delete b.max_completion_tokens; delete b.max_tokens;
    b.messages[1].content = "List the luma directory.";
  }],
];

for (const [label, mutate] of variants) {
  const body = base() as Record<string, any>;
  mutate(body);
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const firstLine = text.split("\n").find((line) => line.trim())?.slice(0, 150) ?? "";
    console.log(`${String(response.status).padEnd(4)} ${label.padEnd(42)} ${firstLine}`);
  } catch (error) {
    console.log(`ERR  ${label.padEnd(42)} ${error instanceof Error ? error.message : String(error)}`);
  }
}

store.db.close();
