import { getEncoding } from "js-tiktoken";

/**
 * System-prompt assembly, kept byte-for-byte compatible with the strings
 * LibreChat injects. Changing any literal here changes model behaviour, so
 * the alignment tests assert on them directly.
 */

export const MEMORY_INSTRUCTIONS =
  "The system automatically stores important user information and can update or delete memories based on user requests, enabling dynamic memory management.";

export const MEMORY_TOOL_USAGE_GUARD = `Only use the \`set_memory\` and \`delete_memory\` tools when the user explicitly asks you to remember, update, or forget something (e.g. "remember that...", "don't forget...", "forget..."). Never store information merely because the user mentioned it in conversation.`;

export const WEB_SEARCH_CONTEXT = `# \`web_search\`:
Use this tool when the user's request calls for it, whether directly, indirectly, or implicitly, or when answering requires information that is current, real-time, or otherwise beyond your own knowledge; for questions you can answer reliably on your own, respond directly without searching. When searching, execute immediately without preface, then provide a brief summary addressing the query directly, then structure your response with clear Markdown formatting (## headers, lists, tables). Cite sources properly, tailor tone to query type, and provide comprehensive details.

Use the conversation date/time from the dynamic runtime context when recency matters.

**CITATION FORMAT - UNICODE ESCAPE SEQUENCES ONLY:**
Use these EXACT escape sequences (copy verbatim): \\ue202 (before each anchor), \\ue200 (group start), \\ue201 (group end), \\ue203 (highlight start), \\ue204 (highlight end)

Anchor pattern: \\ue202turn{N}{type}{index} where N=turn number, type=search|news|image|ref, index=0,1,2...

**Examples (copy these exactly):**
- Single: "Statement.\\ue202turn0search0"
- Multiple: "Statement.\\ue202turn0search0\\ue202turn0news1"
- Group: "Statement. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Highlight: "\\ue203Cited text.\\ue204\\ue202turn0search0"
- Image: "See photo\\ue202turn0image0."

**CRITICAL:** Output escape sequences EXACTLY as shown. Do NOT substitute with † or other symbols. Place anchors AFTER punctuation. Cite every non-obvious fact/quote. NEVER use markdown links, [1], footnotes, or HTML tags.`;

export interface MemoryRow {
  key: string;
  value: string;
  updatedAt: number | string | Date;
}

export interface SearchableFile {
  id: string;
  name: string;
  currentRequest?: boolean;
}

let tokenizer: ReturnType<typeof getEncoding> | undefined;

export function countTokens(value: string) {
  tokenizer ??= getEncoding("o200k_base");
  return tokenizer.encode(value).length;
}

export function composeStaticPrompt(globalPrompt: string, toolPrompt: string) {
  const global = globalPrompt.trim();
  const tool = toolPrompt.trim();
  if (!global) return tool;
  if (!tool) return global;
  return `${global}\n\n${tool}`;
}

export function resolveModelSystemPrompt(globalPrompt: string, override?: string | null) {
  return override?.trim() || globalPrompt;
}

export function renderPromptIdentity(prompt: string, modelName: string, providerName: string) {
  return prompt.replaceAll("{{model_name}}", modelName).replaceAll("{{provider_name}}", providerName);
}

function formatMemoryContext(rows: MemoryRow[], tokenLimit: number) {
  const byAge = (left: MemoryRow, right: MemoryRow) =>
    new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  // Chosen newest first, then rendered oldest first. When the budget binds, the
  // memory to lose is the one written longest ago — the reverse used to be true,
  // and a single oversized row ended the loop, so a stale preference could keep
  // the model from ever learning the user's name.
  let totalTokens = 0;
  const kept: MemoryRow[] = [];
  const skipped: string[] = [];
  for (const row of [...rows].sort(byAge).reverse()) {
    const tokenCount = countTokens(row.value);
    if (totalTokens + tokenCount > tokenLimit) {
      skipped.push(row.key);
      continue;
    }
    totalTokens += tokenCount;
    kept.push(row);
  }
  if (!kept.length) return "";

  const formatted = kept.sort(byAge).map((row, index) => {
    const date = new Date(row.updatedAt).toISOString().split("T")[0];
    return `${index + 1}. [${date}]. ["key": "${row.key}"] [${countTokens(row.value)} tokens]. ["value": "${row.value}"]`;
  });
  // Saying what was left out is the difference between memory that is partial
  // and memory that looks complete.
  const note = skipped.length ? `\n\nOmitted for space: ${skipped.join(", ")}.` : "";
  return `${MEMORY_INSTRUCTIONS}\n\n# Existing memory about the user:\n${formatted.join("\n\n")}${note}`;
}

function buildFileSearchContext(files: SearchableFile[]) {
  if (!files.length) {
    return "- Note: Semantic search is available through the file_search tool but no files are currently loaded. Request the user to upload documents to search through.";
  }
  const lines = ["- Note: Use the file_search tool to find relevant information within:"];
  for (const file of files) {
    lines.push(`\t- ${file.name}${file.currentRequest ? " (just attached by user)" : " (user reference library)"}`);
  }
  return lines.join("\n");
}

/** A document sent with this turn, with as much of its text as fits. */
export interface AttachedDocument {
  id: string;
  name: string;
  text: string;
  /** True when `text` is the head of a longer document. */
  truncated: boolean;
}

/**
 * The text of what the reader just attached, placed in front of the model.
 *
 * Naming the file in the searchable list was not the same as handing over the
 * document, and the difference showed: asked what was in the attachment, the
 * model reached for `file_search`, which searches the whole library, and read
 * back passages from unrelated files. A document that arrives with a question is
 * part of the question. Retrieval is for finding things in a library, not for
 * reading the page someone is holding out.
 *
 * Only this turn carries the text. Later turns keep the reference line the
 * transcript stores, and reaching a document again is what `file_search` with
 * `file_ids` is for — the same arrangement as history images, where the pixels
 * are in the turn that sent them and later turns get a line and `view_image`.
 */
function buildAttachmentContext(documents: AttachedDocument[]) {
  if (!documents.length) return "";
  const blocks = documents.map((document) => {
    const note = document.truncated
      ? `\n[Truncated. Search the rest with file_search, passing file_ids: ["${document.id}"].]`
      : "";
    return `## ${document.name}\n\n${document.text}${note}`;
  });
  const names = documents.map((document) => document.name).join("、");
  return [
    "# Documents attached to this message",
    "",
    `The reader sent ${documents.length === 1 ? "this" : "these"} with the current request, and the full text is below. Answer from it directly.`,
    "",
    `Do not call file_search for ${names} — you are already looking at ${documents.length === 1 ? "it" : "them"}, and a search would return passages from other files instead. Search only where a block below says it was truncated, and then pass that file's id in file_ids.`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

export function buildModelSystemPrompt(input: {
  staticPrompt: string;
  memories: MemoryRow[];
  searchableFiles: SearchableFile[];
  filesEnabled: boolean;
  memoryEnabled: boolean;
  memoryTokenLimit: number;
  webEnabled: boolean;
  /** Documents sent with this turn, text included. */
  attachments?: AttachedDocument[];
  /** One line per available skill. Stable, so it sits in the cached prefix. */
  skillCatalogue?: string;
  now?: string | number | Date;
}) {
  // The layering is the cache contract, not a matter of taste: a provider
  // caches the longest byte-identical prefix it has seen, so everything a turn
  // cannot change has to sit above everything a turn can. Adding a value that
  // moves between turns to `stableParts` costs the whole prompt's cache on
  // every request; it belongs in `volatileParts`, which is always last.
  const stableParts = [
    input.webEnabled ? WEB_SEARCH_CONTEXT : "",
    input.staticPrompt.trim(),
    input.skillCatalogue?.trim() ?? "",
    input.memoryEnabled ? MEMORY_TOOL_USAGE_GUARD : "",
  ];
  const volatileParts = [
    // Truncated to the minute on purpose. The model only needs the date to
    // judge recency, while a millisecond made every request a cache miss:
    // two turns of the same conversation never shared a prefix.
    input.webEnabled
      ? `# \`web_search\` Runtime Context\nConversation Date & Time: ${new Date(input.now ?? Date.now()).toISOString().replace(/:\d\d\.\d+Z$/, ":00.000Z")}`
      : "",
    input.filesEnabled ? buildFileSearchContext(input.searchableFiles) : "",
    input.memoryEnabled ? formatMemoryContext(input.memories, input.memoryTokenLimit) : "",
    // Last, and deliberately: this is the largest volatile block and the one
    // most specific to the turn, so nothing that could have been cached sits
    // behind it.
    buildAttachmentContext(input.attachments ?? []),
  ];
  return [...stableParts, ...volatileParts].filter(Boolean).join("\n\n");
}

