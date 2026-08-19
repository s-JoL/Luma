import type { ModelSpec } from "@shared/types.ts";

/**
 * Last-mile request shaping, applied after the protocol adapter has built the
 * payload.
 */
export function applyModelParameters(payload: unknown, spec: ModelSpec) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...(payload as Record<string, unknown>) };
  if (Number.isFinite(spec.temperature)) next.temperature = spec.temperature;
  if (Number.isFinite(spec.topP)) next.top_p = spec.topP;

  if (spec.librechatCompat) {
    delete next.stream_options;
    delete next.store;
    delete next.max_completion_tokens;
    delete next.max_tokens;
    delete next.prompt_cache_key;
    delete next.prompt_cache_retention;
    if (Array.isArray(next.messages)) {
      next.messages = (next.messages as Array<Record<string, unknown>>).map((message) => {
        const content = message.content;
        if (
          !Array.isArray(content) ||
          !content.every((part) => (part as { type?: string; text?: unknown })?.type === "text" && typeof (part as { text?: unknown }).text === "string")
        ) {
          return message;
        }
        return { ...message, content: content.map((part) => (part as { text: string }).text).join("\n") };
      });
    }
  }

  return next;
}
