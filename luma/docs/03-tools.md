# Tool contracts

Strings in fenced blocks came verbatim from the LibreChat deployment Luma
replaced, and must be reproduced exactly — they are the part of the system the
models were tuned against, and paraphrasing them changes behaviour. This
document is now their only copy; the original tree is gone.

Tool order handed to the model is stable across turns, because reordering
invalidates provider prompt caches.

## 0. The `intent` argument

Injected as the **first** property of every schema below, which is what lets a
client render a live status label as the provider streams the tool input.

```
ALWAYS write this field FIRST, before any other argument. One present-progressive sentence saying what THIS call is about to do: "Searching for OAuth handling in the callback router". Shown to the user as this call's live status. Never name the tool. Sibling calls to one tool must differ.
```

```json
{ "type": "string", "description": "<the string above>" }
```

Rules carried over:

- First key in `properties`. JS object key order is insertion order and every
  provider serializer preserves it, so first-in-schema means first-in-stream.
- Required on the tools whose work is worth narrating — search, memory, vision,
  generation, skills — and optional on the coding tools, where a run of twenty
  reads and edits would otherwise be twenty sentences.
- Stripped from `args` before the tool body runs, so no tool receives a
  parameter it did not declare.
- Not added to MCP tools at all. Their schemas are passed through as the server
  published them; adding a property a third-party server never declared would
  make Luma's own calls fail that server's validation. A client therefore
  renders an MCP call without a live status label.

The label a call is given is the one the model wrote, for the whole life of the
call: nothing rewrites it once the tool settles. The upstream design allowed a
tool to return a replacement label, and we deliberately do not, because rewriting
a present-progressive sentence into a past-tense one cannot be done for the
languages this deployment answers in. The client shows the intent as written and
marks the call as finished or failed around it.

This replaces the hand-written status strings ("生成第 N 张图片") the previous
implementation produced in the runtime.

## 1. `web_search`

Answered by an adapter rather than by a hardcoded provider. `web-search.ts`
keeps a registry keyed by `capabilities.web.provider`, and Tavily is the default
and currently the only entry; a second backend — Brave, SearXNG, Exa, an
OpenAI-compatible relay — is one object registered beside it. The shape is
deliberately the one the generation adapters use (`07-generation.md`): a query
goes in, rows and image results come out, and everything the model actually sees
is the schema and the output format fixed by this section, which do not change
with who answered. An adapter also declares `requiresKey`, so a self-hosted
backend that authenticates by being reachable can be configured without one,
instead of being refused for a missing key it has no use for.

Up to three calls per invocation (general, then images and news when the model
asks for them), no reranker. Page extraction is not built; §9 records why it is
still wanted.

### Description

```
Real-time search. Results have required citation anchors.

Note: Use ONCE per reply unless instructed otherwise.

Anchors:
- \ue202turnXtypeY
- X = turn idx, type = 'search' | 'news' | 'image' | 'ref', Y = item idx

Special Markers:
- \ue203...\ue204 — highlight start/end of cited text (for Standalone or Group citations)
- \ue200...\ue201 — group block (e.g. \ue200\ue202turn0search1\ue202turn0news2\ue201)

**CITE EVERY NON-OBVIOUS FACT/QUOTE:**
Use anchor marker(s) immediately after the statement:
- Standalone: "Pure functions produce same output. \ue202turn0search0"
- Standalone (multiple): "Today's News \ue202turn0search0\ue202turn0news0"
- Highlight: "\ue203Highlight text.\ue204\ue202turn0news1"
- Group: "Sources. \ue200\ue202turn0search0\ue202turn0news1\ue201"
- Group Highlight: "\ue203Highlight for group.\ue204 \ue200\ue202turn0search0\ue202turn0news1\ue201"
- Image: "See photo \ue202turn0image0."

**NEVER use markdown links, [1], or footnotes. CITE ONLY with anchors provided.**
```

In the TypeScript source these appear as `\\ue202`, so the string the model is
shown is a literal backslash followed by `ue202`, not the private-use codepoint
U+E202. Models emit both spellings, so `CITATION_PATTERN` in `web/messages.ts`
accepts either and `markdown.tsx` rewrites both into links. Accepting both was
cheaper than deciding which one is correct and being wrong for one provider.

### Schema

```json
{
  "type": "object",
  "properties": {
    "intent":  { "type": "string", "description": "<intent, §0>" },
    "query":   { "type": "string", "description": "<query guidelines, below>" },
    "date":    { "type": "string", "enum": ["h","d","w","m","y"], "description": "Date range for search results." },
    "country": { "type": "string", "description": "<country guidance, below>" },
    "images":  { "type": "boolean", "description": "Whether to also run an image search." },
    "news":    { "type": "boolean", "description": "Whether to also run a news search." },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 20, "description": "How many results to read. Defaults to 5; raise it for a survey, lower it for a single fact." }
  },
  "required": ["intent", "query"]
}
```

LibreChat's schema also has `videos`. It is not offered here, because no adapter
in the registry has a video sub-search: the parameter accepted the request,
issued no call, and returned an empty list without saying why. A model cannot
correct for a control that silently does nothing.

`max_results` is the model's to set. It was fixed at five, and the only way to
read more was to reissue near-duplicate queries at the same cost each time —
which is a worse answer arrived at more expensively. The model has the question
in front of it and is better placed to know whether five sources settle it.

`query` description:

```
GUIDELINES:
- Start broad, then narrow: Begin with key concepts, then refine with specifics
- Think like sources: Use terminology experts would use in the field
- Consider perspective: Frame queries from different viewpoints for better results
- Quality over quantity: A precise 3-4 word query often beats lengthy sentences

TECHNIQUES (combine for power searches):
- EXACT PHRASES: Use quotes ("climate change report")
- EXCLUDE TERMS: Use minus to remove unwanted results (-wikipedia)
- SITE-SPECIFIC: Restrict to websites (site:edu research)
- FILETYPE: Find specific documents (filetype:pdf study)
- OR OPERATOR: Find alternatives (electric OR hybrid cars)
- DATE RANGE: Recent information (data after:2020)
- WILDCARDS: Use * for unknown terms (how to * bread)
- SPECIFIC QUESTIONS: Use who/what/when/where/why/how
- DOMAIN TERMS: Include technical terminology for specialized topics
- CONCISE TERMS: Prioritize keywords over sentences
```

`country` description:

```
Country to localize search results.
Give an ISO 3166-1 alpha-2 code ("us", "gb", "ca", "de", "fr", "jp", "br") or the country's English name.
Provide this when the search should return results specific to a particular country.
Examples:
- "us" for United States (default)
- "de" for Germany
- "in" for India
```

Tavily wants the English name where the schema asks for a code, so a code is
expanded through `Intl.DisplayNames` and anything else is passed through as
written. There used to be a patch table under that — eight countries spelled the
way Tavily happened to spell them — which was a record of which ones somebody
had tried, not a mapping. A model that writes `Türkiye` or `Côte d'Ivoire`
should have that reach the provider.

Tavily validates the value against its own spelling of the world, so a name it
does not recognise fails the whole call. A rejected request is therefore retried
once without `country`: results for the wrong country beat no results and an
opaque 4xx, and the alternative is keeping the table this tool exists without.

### Pipeline

What the Tavily adapter puts on the wire. `POST https://api.tavily.com/search`,
overridable with `TAVILY_SEARCH_URL` — `Authorization: Bearer <key>`:

```json
{ "query": "…", "search_depth": "basic", "topic": "general", "max_results": 5 }
```

`date` becomes `time_range` on every call, `country` only on the general one.
`images: true` adds a second call with `include_images`,
`news: true` a third with `topic: "news"`. That is the whole chain: no reranker,
and no page extraction — §9 records that snippets alone are the biggest remaining
quality gap, and closing it means calling Tavily's `/extract` over the returned
links.

### Model-visible output

Sections are delimited by:

```
\n\n=== ${title} ===\n\n
```

with titles `Web Results, Turn ${turn}` and `News Results` — the only two
Tavily produces. Each source:

```
# Search ${index}: "${title}"
Anchor: \ue202turn${turn}search${index}
URL: ${link}
Summary: ${snippet}
Date: ${date}
Source: ${attribution}
```

Blank line between sources. There is no highlight block, because there is no
reranker to score one, and no output cap: what comes back is `max_results`
snippets, which the context budget already bounds.

## 2. `file_search`

### Description

Base:

```
Performs semantic search across attached "file_search" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query. Use this to extract specific information or find relevant sections within the available documents.
```

Plus, when citations are on, `\n\n` and:

```
**CITE FILE SEARCH RESULTS:**
Use the EXACT anchor markers shown below (copy them verbatim) immediately after statements derived from file content. Reference the filename in your text:
- File citation: "The document.pdf states that... \ue202turn0file0"  
- Page reference: "According to report.docx... \ue202turn0file1"
- Multi-file: "Multiple sources confirm... \ue200\ue202turn0file0\ue202turn0file1\ue201"

**CRITICAL:** Output these escape sequences EXACTLY as shown (e.g., \ue202turn0file0). Do NOT substitute with other characters like † or similar symbols.
**ALWAYS mention the filename in your text before the citation marker. NEVER use markdown links or footnotes.**
```

### Schema

```json
{
  "type": "object",
  "properties": {
    "intent": { "type": "string", "description": "<intent, §0>" },
    "query":  { "type": "string", "description": "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents." }
  },
  "required": ["intent", "query"]
}
```

### Retrieval

One keyword pass and one embedding pass, both across the whole library rather
than per file, each taking twice the final limit as candidates, fused with
reciprocal rank and cut to ten. Ten is the only number here.

The keyword pass is itself two passes fused the same way: FTS5 over the trigram
index for terms of three characters or more, and a substring scan for the rest.
They used to be alternatives, with the scan reached only when the index returned
nothing at all — so `幂等 idempotent` was served entirely by the English word and
the Chinese one contributed nothing, and passages that only said `幂等` could not
be found. The two also disagreed about recall, the index ORing its terms while
the scan ANDed them, which made the same question narrower in Chinese than in
English. Splitting the query holds back `_` and `-`, which Unicode calls
punctuation and a programmer calls part of the name.

There is no relevance floor on what the model sees. There was one — 0.3 — but it
applied only to semantic hits, since a keyword hit carries no similarity score
and was handed 1.0 by default; the two halves of a hybrid search were being held
to opposite standards, and a query whose best passage sat at 0.28 was answered
with "nothing found". Ranking the candidates is the server's job. Judging whether
the top one answers the question is the model's, and it has read both.

The citation strip in the client lists whatever the model was shown: it parses
the `Anchor:` lines back out of the tool result, so there is no second threshold
and no way for the two to disagree about what the answer rests on.

### Result block

```
File: ${filename}
Anchor: \ue202turn${turn}file${index} (${filename})
Relevance: ${(hit.retrievalScore / best).toFixed(4)}
Content: ${content}
```

Blocks joined with `\n---\n`. The `Anchor` line is omitted when citations are
off. Relevance is the fused retrieval score as a fraction of this query's best
hit, four decimals — so the head of the list is always 1.0000 and the number
says how the rest compare to it, which is the comparison the model can use.

### Searchable-file context

Injected into the stable system prompt, not the tool description. No files:

```
- Note: Semantic search is available through the file_search tool but no files are currently loaded. Request the user to upload documents to search through.
```

Otherwise a header line followed by one line per file:

```
- Note: Use the file_search tool to find relevant information within:
	- report.pdf (just attached by user)
	- notes.docx (user reference library)
```

Suffixes are ` (just attached by user)`, ` (user reference library)`, or empty.

## 3. `memory`

Two tools. The capability id is `memory`; the model never sees that word.

### `set_memory`

```
Saves important information about the user into memory.
```

```json
{
  "type": "object",
  "properties": {
    "intent": { "type": "string", "description": "<intent, §0>" },
    "key":    { "type": "string", "description": "A short snake_case name for what this fact is about. Reuse an existing key when the subject matches, and coin a new one when none fits. Keys in use or suggested: <stored keys, then the suggested seven>" },
    "value":  { "type": "string", "description": "Value MUST be a complete sentence that fully describes relevant user information." }
  },
  "required": ["intent", "key", "value"]
}
```

The key list is advice, not an enumeration. Anything matching
`^[A-Za-z0-9_-]{1,64}$` is accepted and a malformed key comes back as a tool
result saying so, which the model can act on. Listing the keys already stored
first is what discourages the same fact being filed twice under two spellings.

### `delete_memory`

```
Deletes specific memory data about the user using the provided key. For updating existing memories, use the `set_memory` tool instead
```

```json
{
  "type": "object",
  "properties": {
    "intent": { "type": "string", "description": "<intent, §0>" },
    "key":    { "type": "string", "description": "The key of the memory to delete. Currently stored: <stored keys, or \"nothing yet\">" }
  },
  "required": ["intent", "key"]
}
```

### System prompt injection

Appended to the agent instructions when the tools are registered:

```
Only use the `set_memory` and `delete_memory` tools when the user explicitly asks you to remember, update, or forget something (e.g. "remember that...", "don't forget...", "forget..."). Never store information merely because the user mentioned it in conversation.
```

The memory block itself, emitted only when at least one memory exists:

```
The system automatically stores important user information and can update or delete memories based on user requests, enabling dynamic memory management.

# Existing memory about the user:
${formatted}
```

`formatted`, one entry per line pair, joined with `\n\n`:

```
1. [2026-08-18]. ["key": "writing_preferences"] [42 tokens]. ["value": "User prefers direct answers."]
```

The ` [N tokens]` segment is omitted when no token count is stored. When the
delete tool is absent the format degrades to `1. [2026-08-18]. ${value}`.

### Limits

`charLimit` 20 000 on a value, `tokenLimit` 16 000 across all keys, key length
64, tokenizer `o200k_base`. Writes are serialized so the running total cannot
race. Background memory writing stays off.

When the token budget binds, the memory block keeps the most recently written
rows and names the keys it left out, so the model can tell a partial memory from
an empty one. It used to keep the oldest and stop at the first row that did not
fit, which meant a large stale entry could hide everything written after it.

## 4. MCP

MCP is for third-party servers. Image and video generation is **not** one of
them: it is a first-party capability with its own adapters (`07-generation.md`),
so nothing here is required to draw a picture.

Tool names are `{toolName}_mcp_{serverId}`, e.g. `fetch_mcp_web-fetch`, with `:`
in a server id rewritten to `__`. The delimiter `_mcp_` is load bearing — it is
how a call is routed back to its server, and how a profile decides whether a tool
is in scope.

Placeholders in `command`, `args` and `env` are resolved at spawn: `${AIGC_ROOT}`,
`${PROJECT_ROOT}`, `${NODE_EXE}`, and one `${PROVIDER}_API_KEY` per configured
provider, from the secrets table. No other placeholder is resolved; a child
otherwise inherits this process's environment. The call timeout is 600 000 ms.

### Transports

The shape of the stored record decides how it is reached: a command is a child
process over stdio, a URL is a remote server over HTTP. The spec has two
mainstream transports and hosted servers are published on the second one, so a
stdio-only client can talk to whatever it can spawn and to nothing else.
Streamable HTTP is tried first, and the deprecated HTTP+SSE transport is the
fallback, because a server written before that rewrite answers the initial POST
with a 4xx and serves a GET stream instead. When both fail, the error names what
each transport said, since "connection refused" and "404 on POST" call for
different fixes.

A remote record names its endpoint in `url` and its credentials in `headers`,
which are columns of their own rather than a reuse of `command` and `env`: one of
those is a child process's environment, and a header sent to a hosted service is
not. A row that carries neither still works, because a URL written into `command`
selects the HTTP transport and `env` is read as the headers — that is what rows
written before the columns existed look like.

### Schema narrowing

The schema handed to the model is a narrowed copy, because MCP authors write
whatever JSON Schema they like and Google's function-declaration dialect accepts
a small OpenAPI subset and rejects the rest outright — one `multipleOf: 8` on a
ComfyUI width field fails every tool-enabled turn on a Gemini-backed model with
`Unknown name "multipleOf" … Cannot find field`. The allowlist is also the
defensive fallback: a keyword nobody has vetted is dropped rather than forwarded,
so a schema this narrowing has never seen cannot make a provider reject the whole
tool declaration. The studio keeps the original, because it renders the form
itself and a slider genuinely wants the step.

A third-party server is entitled to the whole language, so the structure
survives: `$ref` is resolved against `$defs` and inlined, `allOf` is merged,
`oneOf` becomes `anyOf`, `const` becomes a one-value `enum`, and `enum`,
`default`, `format`, nested `properties` and nested `items` are carried through
untouched. Every mainstream generator lifts a repeated shape into a definition,
and a reference that came through narrowing with no keywords left was typed as a
string, which asked the model to fill an object-shaped argument with prose.

What is still removed, and why:

| Removed | Why |
|---|---|
| `additionalProperties`, `patternProperties`, `propertyNames` | Google rejects them, and an object with no declared extras is already open |
| `not`, `if`/`then`/`else`, `dependentRequired` | Conditional validation has no equivalent in any function-declaration dialect |
| `multipleOf`, `exclusiveMinimum`/`Maximum`, `uniqueItems` | Kept as prose instead |
| a `format` outside Google's list | Kept as prose; the word alone makes it reject the declaration |
| `$schema`, `$id`, `examples`, `readOnly`, `deprecated` | Annotations the model cannot act on and one provider or another refuses |

"Kept as prose" is the rule that makes the removals survivable: the constraint is
appended to the property's description, so the model still knows the width must
be a multiple of eight. A schema-valued `additionalProperties` — which is how a
dictionary argument is written — says so the same way, rather than quietly
becoming an object with only its declared keys. A union `type` keeps its first
non-null member and gains `nullable`, and the alternatives are named in the
description.

### Results

Results are parsed for:

- text → concatenated into the tool message
- images → image content parts
- a `structuredContent` naming an `image_id` → registered as `files` +
  `image_assets` rows, so a server that writes into the asset directory gets its
  output into the library and the gallery

## 5. `code`

Ten tools behind three independent switches — `read`, `write`, `shell` — all off
by default. Names follow `@librechat/agents` where the tool exists there, so
behaviour stays comparable, and the rest are named for what they do.

| Switch | Tool | Parameters after `intent` |
|---|---|---|
| `read` | `read_file` | `path`, `start_line`, `max_lines` (≤2 000, default 2 000) |
| `read` | `glob_search` | `query` (name fragment), `path`, `limit` |
| `read` | `grep_search` | `query`, `path`, `glob`, `limit` |
| `read` | `list_directory` | `path` |
| `write` | `edit_file` | `path`, `old_text`, `new_text`, `expect_revision`, `replace_all`, `edits[]` |
| `write` | `write_file` | `path`, `content`, `expect_revision` |
| `write` | `move_path` | `from`, `to`, `overwrite` |
| `write` | `delete_path` | `path`, `recursive` |
| `write` | `restore_file` | `backup`, `limit` |
| `shell` | `bash_tool` | `command`, `timeout` (seconds, optional, no default) |

Four properties hold across all of them, and each exists because its absence
produced a real failure:

**The workspace is a boundary, not a default.** Every path resolves through the
nearest existing ancestor's `realpath` before being compared to the workspace
root, because `path.relative` alone accepts `link/../../etc` when `link` points
outside.

**A write states what it expected to overwrite.** `read_file` reports a short
content hash as `revision`; passing it back as `expect_revision` turns a
concurrent change into a refusal instead of a silent clobber. Writes are
serialized per file, so two edits in one batch cannot interleave, and a
multi-file `edits[]` is staged entirely in memory before anything is written — a
bad match in the last edit leaves the workspace untouched.

**Losing bytes is recoverable.** Every overwrite and delete copies the previous
content into `data/coding-trash` with a journal line, and `restore_file` lists
and replays them. The trash sits beside the database rather than in the
workspace, where it would appear in the model's own searches and in the user's
version control.

**Destruction asks a person.** `delete_path`, a clobbering `write_file` or
`move_path`, and every `bash_tool` call are held at a preflight gate until
someone approves them (`02-api.md §Approvals`, and `01-data-model.md` for the
`approvals` table). A refusal comes back as an ordinary tool result explaining
why, not as an error the model might retry.

The approval card carries the whole command, and the client renders it wrapped
rather than clipped. A gate that shows the first line of what it is asking about
is not a gate; since the pattern list is gone, this card is the only control
there is, and a reader has to be able to see all of what they are approving.

`read_file` takes pi's own ceiling as its limit — `DEFAULT_MAX_LINES`, 2 000 —
rather than a smaller number of its own, and then bounds what it returns by the
dual limit again: 2 000 lines *or* 50 KB, whichever binds first. A line count
alone does not bound a read, because 2 000 lines of minified source is megabytes.
A cut result ends with the `start_line` to continue from, which is what makes the
cut recoverable; without it the model cannot tell whether there is more and can
only ask for the same range again.

`grep_search` uses ripgrep when it is installed and falls back to a Node scan
when it is not, because the search is too useful to fail on a missing binary. The
fallback also catches a ripgrep that cannot be launched rather than one that is
absent — a `.cmd` shim on `PATH`, which Node refuses to spawn without a shell,
and a shell here would hand the model's query to the interpreter as syntax. Both
engines cut a match line at pi's grep width and mark it `... [truncated]`, so a
cut line is distinguishable from a short one and one minified match cannot fill
the whole result on its own. A recursive delete refuses above 200 files.
`bash_tool` is `pi-agent-core`'s
`createBashTool` over a `NodeExecutionEnv` rooted at the workspace: one bash on
every host, with streaming output, truncation to an overflow file, and
process-tree kills. Luma used to spawn PowerShell on Windows and `/bin/sh`
elsewhere, which made the language the model had to write a property of the
machine it happened to be running on.

Capability config: workspace root plus the three switches.

## 6. `use_skill`

A skill is a written procedure the model can pull in when a task calls for it,
stored as `data/skills/<name>/SKILL.md` — `name` and `description` in the
frontmatter, the procedure in the body. Loading, frontmatter parsing and the
`<skill>` wrapper are `pi-agent-core`'s (`loadSkills`, `formatSkillInvocation`);
Luma only points them at a directory and exposes the result as a tool.

The prompt gets one line per skill:

```
# Skills

These are written procedures for specific kinds of work. When one matches the
task, call `use_skill` with its name and follow the instructions it returns
before doing the work yourself.

- <name>: <description>
```

The body — which is the whole point and can be thousands of tokens — is returned
only by a call, and only for the skill that was asked for. That is what makes a
large library affordable: the prompt grows by a line per skill, not a document
per skill. The catalogue is stable within a turn, so it belongs in the cached
prefix (`04-agent.md §Prompt assembly`).

Parameters after `intent`: `name`, enumerated in the parameter description so a
misspelling is a schema violation rather than a failed call. An unknown name
still answers with the list of loadable skills instead of an error.

There is no setting and no capability row. A conversation gains the capability by
there being a skill on disk and loses it by there not being one: an empty or
missing directory contributes no prompt section and no tool. A skill whose
frontmatter sets `disable-model-invocation: true` is loaded but never advertised
or reachable, and a malformed file is a warning on the server log, not a failed
run.

## 7. Generation

`generate_image`, `edit_image` and `generate_video`, each present only when the
conversation's profile names a model that can run the operation. Their parameters
are not written here on purpose: they come from the adapter's schema, which is the
same schema the studio renders as a form, so the two can never describe different
things. `intent` is prepended as everywhere else and stripped before the job runs.

The call submits a job and forwards its progress as ordinary tool progress. What
comes back is split by audience: the model is handed the finished picture as
base64 in the tool result, because seeing it is what lets it decide between
another edit and an answer, while the transcript keeps only an `image_ref` or
`video_ref`, so a long conversation never carries the bytes twice.
`07-generation.md` has the operations, the adapters and the queue.

## 8. `view_image`

One parameter after `intent`: `image_id`. It answers with that image, downscaled
the same way every other image is, and with an explanatory sentence when the id
names nothing readable.

It is registered only when the model accepts image input *and* the branch being
sent actually carries an `image_ref`. Both halves are the same argument as the
empty skill library in §6: a text-only model would call it and have the image
part stripped on the way to the provider, and a conversation with no picture in
it can only ever get an error back. An image attached to the current turn does
not count, because it is already in context as pixels.

It exists because the transcript names past images rather than carrying them
(`04-agent.md §Images`). Naming without a way to load would make the model
guess; loading everything would make every turn cost twenty images. The tool is
the third option, and it is the model that decides. Editing does not need it —
`edit_image` reads its source itself.

## 9. Deliberate divergences

| LibreChat | Luma | Reason |
|---|---|---|
| `resendFiles` re-encodes all historical images every turn | Past images are named in the transcript and loaded by `view_image` | Cost. A twenty-image conversation would re-upload twenty images per turn |
| Tool results truncated at a fixed 12 000 characters | Bounded at pi's 2 000 lines / 50 KB in the model's context and in the persisted transcript alike, while the current turn still streams whole to the client; the pruner drops whole messages against the real token budget when the branch stops fitting | A character cap cuts the compiler error in half and charges a Chinese result three times an English one; a line-and-byte pair cuts on a line boundary and says how much it left behind |
| Background memory agent available | Explicit tool calls only | `agent.enabled: false` was the configured behaviour anyway |
| Title generated by `@librechat/agents` `generateTitle` | Our own call, on a minimal naming prompt rather than the chat persona | No dependency on the SDK for a single completion, and the persona answered a naming request the way it answers a turn |
| Conversation title from truncation *(previous Luma)* | Real LLM call, immediate, parallel with the answer; truncating the user's opening line survives only as the fallback when the call returns nothing usable | Restores LibreChat behaviour; truncation as the mechanism was the regression, but as the fallback it beats a conversation that stays untitled |
| `/search` + `/extract` | `/search` only, still | Not yet built. Snippets alone are the biggest open quality gap in this file |
| `videos` search parameter | Absent | No adapter in the registry has a video sub-search: the flag issued no call and returned nothing without saying so |
| `max_results` fixed at 5 | Model-chosen, 1–20 | The model holds the question and knows whether five sources settle it |
