import type { ModelRegistry } from "../models/registry.ts";

const TITLE_INSTRUCTION =
  "Title only the conversation below. Ignore the system message, model identity, provider names, and tool names when choosing the title. Return only a concise title in the conversation's language, at most 5 words.";

/**
 * Naming runs on its own instructions rather than the conversation's. Sending
 * the chat persona made the model answer this call the way it answers a turn —
 * with a preamble, a code fence, or a tool call it had no tools to make — and
 * every one of those reached the sidebar as the conversation's name. It also
 * paid for the whole persona on every new conversation.
 */
const TITLE_SYSTEM_PROMPT =
  "You name conversations. Reply with the title text only: no preface, no explanation, no quotation marks, no markup, no code fences, and no tool calls. You have no tools.";

const MAX_EXCERPT = 2000;

/** A title is one short line. Anything longer is prose nobody asked for. */
const MAX_TITLE = 60;

/**
 * Markup a model emits when it answers the naming call with a tool call
 * instead of a title. Tested before anything is stripped, because
 * `<path>/etc/passwd</path>` reads as an ordinary title once its tags are gone.
 */
const TOOL_CALL_MARKUP =
  /<\/?(?:tool_call|tool|function|parameter|invoke)\b|<(?:function|parameter)=|\btool_call\b|\bfunction_call\b/i;

/** `<|eos|>`, `<|im_end|>` and the rest of the special-token vocabulary. */
const CONTROL_TOKEN = /<\|[^|>]*\|>/g;
const CODE_FENCE = /```+[^\s`]*/g;
const TAG = /<\/?[A-Za-z][^>]*>/g;
const LABEL = /^(?:title|标题|名称)\s*[:：]\s*/i;
/** `web_search(query=…)`, once the surrounding markup is gone. */
const CALL_SYNTAX = /^[a-z][a-z0-9_.]*\(/i;

function firstLine(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labelled = lines.map((line) => (LABEL.test(line) ? line.replace(LABEL, "").trim() : "")).find(Boolean);
  // A line ending in a colon introduces the title rather than being it.
  return labelled ?? lines.find((line) => !/[:：]$/.test(line)) ?? "";
}

/**
 * Reduces whatever came back to a single short line, or to nothing. An empty
 * result is a real answer: the caller falls back to the user's own opening
 * line, which is always better than a fragment of tool-call syntax.
 */
function clean(value: string) {
  if (TOOL_CALL_MARKUP.test(value)) return "";
  const text = firstLine(value.replace(CONTROL_TOKEN, " ").replace(CODE_FENCE, " ").replace(TAG, " "))
    .replace(LABEL, "")
    .replace(/^["'“”「『]+|["'“”」』]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。!！?？]+$/, "")
    .trim();
  if (CALL_SYNTAX.test(text)) return "";
  if (text.length <= MAX_TITLE) return text;
  // Cutting a long answer at the character limit is what produced titles that
  // stopped mid-word, so the cut goes to the first clause that fits instead.
  const head = text.slice(0, MAX_TITLE);
  const boundary = head.search(/[.。!！?？;；,，]/);
  return (boundary > 0 ? head.slice(0, boundary) : head.replace(/\s+\S+$/, "")).trim();
}

/**
 * The name to use when the naming call produced nothing usable: the user's own
 * opening line, shortened the same way a generated title is.
 */
export function fallbackTitle(userText: string) {
  return clean(userText);
}

/**
 * Names a conversation with a separate, cheap completion rather than
 * truncating the user's first message. Failure is silent: an untitled
 * conversation is better than a failed run.
 */
export async function generateTitle(input: {
  registry: ModelRegistry;
  modelId: string;
  userText: string;
  assistantText: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { model } = input.registry.resolve(input.modelId);
  const conversation = [
    `User: ${input.userText.slice(0, MAX_EXCERPT)}`,
    input.assistantText ? `Assistant: ${input.assistantText.slice(0, MAX_EXCERPT)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const message = await input.registry.runtime.completeSimple(
    model,
    {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `${TITLE_INSTRUCTION}\n\n${conversation}` }],
          timestamp: Date.now(),
        },
      ],
    } as never,
    { signal: input.signal, thinkingLevel: "off" } as never,
  );

  const text = (message.content ?? [])
    .filter((part) => (part as { type?: string }).type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join(" ");
  return clean(text);
}

export { TITLE_INSTRUCTION };
