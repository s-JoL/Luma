/**
 * Captures the exact JSON a provider receives, in memory, using synthetic
 * content only. Proves request shaping (tool schemas, intent-first ordering,
 * thinking level, cache-prefix stability) and reproduces provider-side
 * rejections without touching any real transcript.
 *
 *   node --import tsx scripts/audit-payload.ts [modelId]
 *
 * It runs on a scratch data directory by default, because it belongs to the
 * audit chain and an audit must not open the live databases. Point
 * `LUMA_DATA_DIR` at a real instance to shape payloads for the models that
 * instance actually has configured.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { isChatKind, type ModelSpec } from "@shared/types.ts";

process.env.LUMA_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "luma-payload-"));

// Imported after the data directory is settled, since `env.ts` reads it on load.
const { applyModelParameters } = await import("../src/server/models/params.ts");
const { createServices } = await import("../src/server/services.ts");

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

/**
 * Shaping that must hold without a provider, a key, or a configured row, so it
 * is asserted directly rather than read off a captured payload. Every check
 * below is about the same thing: `safetySettings` is the one request field whose
 * absence changes what the model is willing to answer, and it reaches only one
 * protocol.
 */
function checkSafetyShaping() {
  const base = {
    id: "probe",
    providerId: "probe",
    name: "Probe",
    model: "gemini-3.7-flash",
    kind: "chat" as const,
    enabled: true,
    pinned: false,
    reasoning: false,
    input: ["text" as const],
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevel: "off" as const,
    librechatCompat: false,
    agentTool: false,
    sortOrder: 0,
    ops: [],
  };

  const google = applyModelParameters({ contents: [] }, { ...base, apiMode: "google-generative" } as ModelSpec) as {
    config?: { safetySettings?: Array<{ category: string; threshold: string }> };
  };
  const settings = google.config?.safetySettings ?? [];
  if (!settings.length) violations.push("google-generative sent no safetySettings, so the gateway's default filter applies");
  if (settings.some((entry) => entry.threshold !== "OFF")) {
    violations.push(`a category is not OFF: ${settings.map((entry) => entry.threshold).join(",")}`);
  }
  if (!settings.some((entry) => entry.category === "HARM_CATEGORY_SEXUALLY_EXPLICIT")) {
    violations.push("the category this deployment's persona actually trips is not in the list");
  }

  // A row that states its own policy keeps it: the default is Luma declining to
  // add a filter, not Luma insisting there be none.
  const strict = [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" }];
  const overridden = applyModelParameters(
    { contents: [] },
    { ...base, apiMode: "google-generative", params: { safetySettings: strict } } as ModelSpec,
  ) as { config?: { safetySettings?: unknown } };
  if (JSON.stringify(overridden.config?.safetySettings) !== JSON.stringify(strict)) {
    violations.push("a row's own safetySettings were overwritten by the default");
  }

  // On the OpenAI-compatible path the field is accepted and ignored by the
  // gateway, so sending it would only be a lie about what is being enforced.
  const compatible = applyModelParameters({ messages: [] }, { ...base, apiMode: "openai-chat" } as ModelSpec) as Record<
    string,
    unknown
  >;
  if ("config" in compatible || "safetySettings" in compatible || "safety_settings" in compatible) {
    violations.push("safety settings leaked onto a protocol that ignores them");
  }
}

checkSafetyShaping();

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
