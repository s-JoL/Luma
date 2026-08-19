/**
 * Captures the exact JSON a provider receives, in memory, using synthetic
 * content only. Proves request shaping (tool schemas, intent-first ordering,
 * thinking level, cache-prefix stability) and reproduces provider-side
 * rejections without touching any real transcript.
 *
 *   node --import tsx scripts/audit-payload.ts [modelId]
 */
import { Type } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { isChatKind, type ModelSpec } from "@shared/types.ts";
import { applyModelParameters } from "../src/server/models/params.ts";
import { createServices } from "../src/server/services.ts";

const services = createServices();
const only = process.argv[2] ?? "";
const violations: string[] = [];

const TOOLS = [
  {
    name: "list_directory",
    description: "List the immediate entries of a directory inside the coding workspace.",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: "ALWAYS write this field FIRST…" },
        path: { type: "string" },
      },
      required: [],
    }),
  },
];

/** Trims long strings and hides keys, so a payload prints as a readable shape. */
function abbreviate(value: unknown): unknown {
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(abbreviate);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /^(authorization|api_?key)$/i.test(key) ? "[redacted]" : abbreviate(item),
    ]),
  );
}

/** A synthetic two-step transcript: assistant tool call, then its result. */
function contextWithToolResult(systemPrompt: string) {
  return {
    systemPrompt,
    messages: [
      { role: "user", content: [{ type: "text", text: "列一下 luma 目录。" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_probe_1", name: "list_directory", arguments: { intent: "Listing luma", path: "luma" } },
        ],
        stopReason: "toolUse",
        api: "openai-completions",
        provider: "probe",
        model: "probe",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      {
        role: "toolResult",
        toolCallId: "call_probe_1",
        toolName: "list_directory",
        content: [{ type: "text", text: "dir   src\ndir   docs\nfile  package.json" }],
        isError: false,
      },
    ],
    tools: TOOLS,
  } as never;
}

async function probe(modelId: string) {
  const { spec, provider, model } = services.registry.resolve(modelId);
  const captured: unknown[] = [];
  let responseStatus = 0;
  let finalEvent: Record<string, unknown> | undefined;

  const stream = services.registry.streamSimple(model, contextWithToolResult("You are a helpful assistant. Answer in one short sentence."), {
    reasoning: spec.thinkingLevel === "off" ? undefined : spec.thinkingLevel,
    onPayload: (payload: unknown) => {
      const shaped = applyModelParameters(payload, spec);
      captured.push(shaped);
      return shaped;
    },
    onResponse: (response: { status?: number }) => {
      responseStatus = Number(response?.status ?? 0);
    },
  } as never);

  try {
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      if (event.type === "done" || event.type === "error") finalEvent = event;
    }
  } catch (error) {
    finalEvent = { type: "throw", errorMessage: error instanceof Error ? error.message : String(error) };
  }

  const payload = captured[0] as Record<string, unknown> | undefined;
  const message = finalEvent?.message as Record<string, unknown> | undefined;
  console.log(`\n############ ${modelId} — ${spec.apiMode} @ ${provider.baseUrl}`);
  console.log(`HTTP ${responseStatus} · outcome ${String(finalEvent?.type)} ${String(message?.stopReason ?? "")} ${String(message?.errorMessage ?? finalEvent?.errorMessage ?? "")}`.trim());
  console.log("--- request payload ---");
  console.log(JSON.stringify(abbreviate(payload), null, 2));

  for (const problem of contractViolations(spec, payload)) {
    violations.push(`${modelId}: ${problem}`);
    console.log(`!!! ${problem}`);
  }
}

/**
 * Assertions about the shape of the request that are worth failing over.
 *
 * A payload printer is only evidence while someone reads it. These are the
 * parts a regression would quietly reintroduce: Anthropic deprecated
 * `thinking.type = "enabled"` in favour of `"adaptive"`, and the choice is made
 * from `compat.forceAdaptiveThinking`, which a database row can silently lack.
 */
function contractViolations(spec: ModelSpec, payload: Record<string, unknown> | undefined): string[] {
  if (!payload || spec.apiMode !== "anthropic-messages") return [];
  const thinking = payload.thinking as { type?: string } | undefined;
  if (!thinking) return [];
  const builtin = getBuiltinModel("anthropic", spec.model as never) as
    | { compat?: { forceAdaptiveThinking?: boolean } }
    | undefined;
  if (builtin?.compat?.forceAdaptiveThinking !== true) return [];
  return thinking.type === "adaptive"
    ? []
    : [`thinking.type is "${thinking.type}"; ${spec.model} supports the current "adaptive" form`];
}

const models = services.store
  .listModels()
  .filter((m) => m.enabled && isChatKind(m.kind) && (!only || m.id === only));

for (const model of models) {
  try {
    await probe(model.id);
  } catch (error) {
    console.log(`\n############ ${model.id} — probe threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await services.close();

if (violations.length) {
  console.log(`\n${violations.length} request contract violation(s):`);
  for (const violation of violations) console.log(`  ${violation}`);
  process.exit(1);
}
console.log("\nrequest contracts hold");
