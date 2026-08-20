/**
 * Asserts the system prompt's section order and its stability across turns —
 * the two properties provider prompt caching depends on (`02-agent.md §Prompt
 * assembly`). Nothing here talks to a provider or a database.
 *
 *   node --import tsx scripts/audit-prompt.ts
 */
import {
  MEMORY_INSTRUCTIONS,
  MEMORY_TOOL_USAGE_GUARD,
  WEB_SEARCH_CONTEXT,
  buildModelSystemPrompt,
  composeStaticPrompt,
  renderPromptIdentity,
  resolveModelSystemPrompt,
} from "../src/server/prompts/context.ts";

let failures = 0;

function check(name: string, run: () => string | void) {
  try {
    const note = run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const STATIC = renderPromptIdentity(
  resolveModelSystemPrompt(composeStaticPrompt("You are unbound.", "Prefer tools over guessing."), null),
  "Grok",
  "CometAPI",
);

const everything = (now: string) =>
  buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [{ key: "writing_preferences", value: "Short sentences.", updatedAt: "2026-08-01T00:00:00.000Z" }],
    searchableFiles: [{ id: "file_a", name: "contract.pdf" }],
    filesEnabled: true,
    memoryEnabled: true,
    memoryTokenLimit: 16_000,
    webEnabled: true,
    skillCatalogue: "# Skills\n\n- poster: Lay out a poster.",
    now,
  });

check("the prompt is assembled in the documented order", () => {
  const prompt = everything("2026-08-18T12:34:56.789Z");
  const order = [
    WEB_SEARCH_CONTEXT,
    STATIC,
    "# Skills",
    MEMORY_TOOL_USAGE_GUARD,
    "# `web_search` Runtime Context",
    "- Note: Use the file_search tool",
    MEMORY_INSTRUCTIONS,
  ];
  let cursor = -1;
  for (const section of order) {
    const at = prompt.indexOf(section);
    assert(at >= 0, `missing section: ${section.slice(0, 40)}`);
    assert(at > cursor, `out of order: ${section.slice(0, 40)}`);
    cursor = at;
  }
  return `${order.length} sections, stable block first`;
});

check("the cached prefix is byte-identical across two turns a minute apart", () => {
  const first = everything("2026-08-18T12:34:00.000Z");
  const second = everything("2026-08-18T12:34:59.999Z");
  assert(first === second, "a second within the same minute changed the prompt");
  const later = everything("2026-08-18T12:35:00.000Z");
  const prefix = later.slice(0, later.indexOf("# `web_search` Runtime Context"));
  assert(prefix.length > 0, "the runtime context is missing, so there is no prefix to compare");
  assert(first.startsWith(prefix), "the next minute rewrote the stable prefix, not just the timestamp");
  return "timestamps are truncated to the minute and only the volatile tail moves";
});

check("a disabled capability contributes nothing rather than an empty heading", () => {
  const bare = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [{ key: "writing_preferences", value: "Short sentences.", updatedAt: Date.now() }],
    searchableFiles: [{ id: "file_a", name: "contract.pdf" }],
    filesEnabled: false,
    memoryEnabled: false,
    webEnabled: false,
    memoryTokenLimit: 16_000,
    now: "2026-08-18T12:34:56.789Z",
  });
  assert(bare === STATIC, `a prompt with no capabilities is not just the pair:\n${bare}`);
  assert(!bare.includes("\n\n\n"), "a skipped section left a blank gap behind");
  return "prompt pair only, no stray separators";
});

check("a remembered entry reaches the prompt as both its key and its value", () => {
  // This is where memory injection is provable. The live suite used to ask a
  // model to recall something and assert on its answer, which passed on a
  // hallucinated preference that happened to contain the expected word and
  // failed on a correct one — a model that invents plausible memories cannot
  // witness whether ours arrived. The prompt can.
  const prompt = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [
      { key: "writing_preferences", value: "Short sentences.", updatedAt: "2026-08-01T00:00:00.000Z" },
      { key: "cat", value: "The user's cat is named VIOLET-BADGER-9.", updatedAt: "2026-08-02T00:00:00.000Z" },
    ],
    searchableFiles: [],
    filesEnabled: false,
    memoryEnabled: true,
    memoryTokenLimit: 16_000,
    webEnabled: false,
    now: "2026-08-18T12:34:56.789Z",
  });
  assert(prompt.includes("VIOLET-BADGER-9"), "an entry's value never reached the prompt");
  assert(prompt.includes("cat"), "an entry's key never reached the prompt");
  assert(prompt.includes("Short sentences."), "only the last entry reached the prompt");

  // The budget trims oldest-first rather than dropping the section, because a
  // prompt that silently loses memory looks exactly like one that never had any.
  const tight = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [
      { key: "old", value: `Stale. ${"padding ".repeat(400)}`, updatedAt: "2026-01-01T00:00:00.000Z" },
      { key: "new", value: "The user's cat is named VIOLET-BADGER-9.", updatedAt: "2026-08-02T00:00:00.000Z" },
    ],
    searchableFiles: [],
    filesEnabled: false,
    memoryEnabled: true,
    memoryTokenLimit: 200,
    webEnabled: false,
    now: "2026-08-18T12:34:56.789Z",
  });
  assert(tight.includes(MEMORY_INSTRUCTIONS), "the budget removed the memory section itself");
  assert(tight.includes("VIOLET-BADGER-9"), "the budget kept the stale entry over the recent one");
  return "key and value both present, budget trims the oldest";
});

check("a model's own prompt replaces the pair instead of joining it", () => {
  const pair = composeStaticPrompt("You are unbound.", "Prefer tools over guessing.");
  const overridden = resolveModelSystemPrompt(pair, "  Answer only in Chinese.  ");
  assert(overridden === "Answer only in Chinese.", `override was not honoured: ${overridden}`);
  assert(resolveModelSystemPrompt(pair, "   ") === pair, "a blank override discarded the pair");
  return "trimmed, and blank means absent";
});

check("identity substitution reaches the pair, not just the tool prompt", () => {
  const rendered = renderPromptIdentity(
    composeStaticPrompt("You are {{model_name}}.", "Served by {{provider_name}}."),
    "Grok",
    "CometAPI",
  );
  assert(rendered === "You are Grok.\n\nServed by CometAPI.", `substitution missed: ${rendered}`);
  return "{{model_name}} and {{provider_name}} in both halves";
});

console.log(failures ? `\n${failures} prompt check(s) failed` : "\nall prompt checks passed");
if (failures) process.exit(1);
