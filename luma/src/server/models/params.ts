import type { ModelSpec } from "@shared/types.ts";

/**
 * Gemini's filter, turned off.
 *
 * This is the product's boundary, not a preference: filtering belongs to the
 * upstream gateway or a downstream component, and Luma does not add a second
 * layer of its own (`00-product.md`). A model that answers
 * `finish_reason: content_filter` to the shipped persona is not enforcing the
 * operator's policy, it is enforcing a default nobody chose.
 *
 * `OFF` rather than `BLOCK_NONE`: the newer models treat `BLOCK_NONE` as "use
 * the default" unless the account is allow-listed, while `OFF` disables the
 * category outright. A row can override the whole list through
 * `params.safetySettings`, which is also how a stricter setting is chosen.
 *
 * The field only exists on Google's own protocol. Sent to an OpenAI-compatible
 * endpoint it is silently dropped — measured against CometAPI, which answered
 * 200 to a deliberately invalid category on `/v1/chat/completions` and 400 on
 * `/v1beta/…:generateContent`. So `google-generative` is the only api mode where
 * asking for this means anything.
 */
const SAFETY_OFF = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
].map((category) => ({ category, threshold: "OFF" }));

/**
 * Last-mile request shaping, applied after the protocol adapter has built the
 * payload.
 */
export function applyModelParameters(payload: unknown, spec: ModelSpec) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...(payload as Record<string, unknown>) };
  if (Number.isFinite(spec.temperature)) next.temperature = spec.temperature;
  if (Number.isFinite(spec.topP)) next.top_p = spec.topP;

  if (spec.apiMode === "google-generative") {
    // The Google client takes generation options under `config`, so the setting
    // goes there rather than at the top level, and an existing config is kept.
    const configured = (spec.params as { safetySettings?: unknown } | undefined)?.safetySettings;
    const config = { ...((next.config as Record<string, unknown> | undefined) ?? {}) };
    if (config.safetySettings === undefined) {
      config.safetySettings = Array.isArray(configured) ? configured : SAFETY_OFF;
    }
    next.config = config;
  }

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
