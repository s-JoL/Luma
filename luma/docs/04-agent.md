# Agent loop and message construction

This is requirement one: the model call, the model configuration, and the
message array must behave like LibreChat's. LibreChat assembles this across
`AgentClient.buildMessages`, `applyContextToAgent`, `formatAgentMessages` and
the pruner inside `@librechat/agents`. We do it in one place.

## Prompt assembly

There is one system prompt string, assembled stable-part-first. That order is the
whole reason provider prompt caching works: everything a turn cannot change sits
in a byte-identical prefix, and everything that changes per turn is appended after
it.

**Stable.** Identical across the turns of one conversation.

1. The `web_search` contract from `03-tools.md §1`, when web search is on.
2. The prompt pair — the profile's or the deployment's `globalPrompt` and
   `toolPrompt`, joined by a blank line, or the model's own `system_prompt` when it
   sets one — with model identity substituted into it.
3. The skill catalogue: one line per skill on disk (`03-tools.md §6`). Read from
   disk per run, so a new skill takes effect on the next turn, and stable within
   the turn.
4. The memory tool guard, when memory is on.

**Volatile.** Rebuilt every turn, always after the stable block.

1. The `web_search` runtime context — the conversation date, truncated to the
   minute, because a millisecond made every single request a cache miss.
2. The searchable-file list from `03-tools.md §2`, with the files attached to this
   turn marked as belonging to the current request.
3. The memory block, exactly as specified in `03-tools.md §3`.

Order is fixed and asserted by `scripts/audit-prompt.ts`. Reordering these
silently degrades cache hit rate and changes model behaviour.

## Model parameters

The `modelSpec.preset` keys that were actually used, under our own column names:

| Column | Sent to provider |
|---|---|
| `model` | yes — the wire name |
| `thinking_level` | yes, when not `off`, mapped per model by `thinking_level_map` |
| `max_tokens` | yes — the output allowance |
| `temperature`, `top_p` | yes, but only when set; null means "do not send" |
| `context_window` | no — local budget only |
| `system_prompt` | no — becomes the stable `instructions` |
| `name` | no — UI and identity substitution |

The budget is `max(1024, context_window - max(max_tokens, 16384))`. LibreChat's
5 % reserve was the wrong shape and has been dropped: 5 % of a 500k window is
25k of headroom in front of a model whose `max_tokens` is 65 536, so the input
side was authorised to fill 475k and the request could only overflow. What the
model is allowed to emit is the one number that says how much room its reply
needs, and pi's own 16 384 is the floor for a row that understates it. The same
reservation is used by the pruner and by the compactor, so the two cannot
disagree about how much context is spendable.

`temperature` and `top_p` are the one place we went beyond the archived
configuration, because a local model that needs a lower temperature is a real
case; leaving them null keeps the request byte-identical to what it was.
Deliberately still not offered: `frequency_penalty`, `presence_penalty`, `stop`,
`imageDetail`, `useResponsesApi`, `verbosity`, `disableStreaming`,
`fileTokenLimit`.

`librechat_compat` is applied last, after the protocol adapter has built the
payload: it strips the fields LibreChat never sent and collapses all-text content
arrays into plain strings, because a few upstreams now depend on that shape.

## History

History comes from the conversation's **session tree**, not from the `messages`
table. The tree is `@earendil-works/pi-agent-core`'s session: an append-only log
of entries in `data/sessions.sqlite`, one session per conversation, with a single
lane named `main` marking the current branch. `messages` is a projection of it
(`01-data-model.md §Transcripts`).

The message array for a turn is the branch, oldest-first, with everything before
the newest `compaction` entry replaced by that entry's summary and retained tail.
So the model sees a bounded context while the reader keeps every original
message — a compaction adds an entry, it never deletes one.

Two consequences the code must honour:

- Summaries are custom-role messages. The agent's default LLM converter drops
  every role it does not recognise, so the harness `convertToLlm` has to be
  passed explicitly. Without it a compacted conversation silently loses all of
  its history at the moment it needs it most.
- A rewind (edit or regenerate) moves the lane back to the entry before the
  replaced turn rather than deleting rows. The abandoned turn stays in the tree,
  the projection is re-derived from the new branch, and client sequence numbers
  are renumbered from zero — which is why a client that sends `fromSeq` must
  refetch the transcript rather than topping it up.

## Compaction and pruning

Compaction is the real answer to a conversation outgrowing its window: a model
call summarizes the older part into a `compaction` entry before the run starts.

```
reserveTokens    = clamp(max(max_tokens, 16384), 1024, contextWindow * 0.5)
keepRecentTokens = clamp(contextWindow * 0.25, 2048, 20000)
compact when     estimated context tokens > contextWindow - reserveTokens
```

`reserveTokens` is the same absolute reservation the pruner uses, not a share of
the window, so compaction fires earlier on a model that can emit 65k than pi's
16 384 default would have it — which is the point, because that output has to fit
too. Half the window is the ceiling: past that there is no room left to summarize
into. `keepRecentTokens` still scales, because pi's 20k retained is right for a
200k model and more than exists on a 32k one; the caps keep large models on the
upstream defaults.

Repeated compactions build on the previous summary rather than starting over, and
the summary's own token cost is recorded in the tree's usage ledger.

The summary call carries a retry policy of its own — three attempts, 1 s base
delay, pi's harness default. Summarizing is an ordinary provider call but it runs
outside the wrapper that retries a turn, so one transient 502 used to drop into
the error callback and leave the run on a merely-pruned context that was still
over budget.

The summariser is an ordinary model call, so what it is sent is projected the
same way a turn is: `describeRefs` runs over the messages being summarized
before they go out. Handing it raw `image_ref` parts made every provider adapter
emit an image block with no data, so summarizing failed — quietly, into the
error callback — for exactly the conversations long enough to need it. The
retained tail is left alone, because it is persisted and projected again on the
way back out.

Pruning remains as the fallback for when summarizing was unavailable or did not
free enough, over the budget:

```
budget = max(1024, context_window - max(max_tokens, 16384))
usable = max(1024, budget - tokens(system prompt) - tool schema tokens)
```

1. Drop assistant messages that terminated in an error. They are noise and never
   help the next turn.
2. Drop image parts with no data. `image_omitted` is kept: it records a picture
   that reached the transcript without an id, and `describeRefs` renders it as
   `[image unavailable …]`. Deleting it left the model answering as though the
   turn had been text.
3. Drop whole messages from the oldest end, always at a user-message boundary so
   a turn is never half-present.

A leading summary message is held out of step 3: dropping it would throw away
the one message standing in for everything already compacted.

Tool results are bounded *before* any of this, so the pruner counts what will
actually be sent rather than the tool's full output
(`00-architecture.md §Alignment posture`). Dropping a whole turn to make room for
bytes the provider was never going to be shown is the failure that ordering
avoids.

Tool schema tokens are counted **after** `intent` injection. Counting before it
understates the budget by roughly 40–60 tokens per tool, which across a full
tool set is a real miss.

The original implementation used `if (messages.length > 36) keep the last 10
user turns`, with no reference to the actual window. A 1M-context model and a
32k model got identical treatment. That is the behaviour being replaced.

## Images

Persisted messages never contain base64. An image in history is:

```json
{ "type": "image_ref", "image_id": "img_<32 hex>", "mime_type": "image/png",
  "width": 1152, "height": 1536, "parent_image_ids": [], "provider": "comfy" }
```

On the way to the model each reference becomes a line of text —
`[image image_id=img_… 1152x1536 image/png]` — so the transcript states which
pictures exist and what they are called. Pixels arrive only when the model calls
`view_image` with an id, and that tool is on the menu only when the branch holds
an image to name (`03-tools.md §8`). An image the user attaches to the current
turn is sent directly, since asking to look at what was just handed over is
theatre.

The rule used to be a keyword test: a regex of image-ish words (`picture`,
`这张`, `look at`, …) against the last three turns, and if it matched, the three
most recent images were silently attached. It failed in both directions. "What
does the third one say?" does not match, so the model answered blind; "make it
brighter" does match, so two irrelevant images were paid for on every edit. The
model knows whether it needs to see something and the transcript now tells it
what is available — so it asks, and the guess is gone.

Cost is the reason there is a gate at all; LibreChat's `resendFiles: true`
re-encodes every historical image on every turn. See `03-tools.md §7`.

## Title generation

A separate, cheap completion, fired in parallel with the main answer on the
first turn of a new conversation.

- Trigger: first message, new conversation, not archived.
- Timing: immediate — dispatched alongside the main run, not after it.
- Model: the configured title model when it is set and enabled, otherwise the
  conversation's own. Thinking is off for this call.
- Output-token limits from the chat model are not applied to this call.
- The result is persisted and pushed to clients as a `conversation.title` event.

Naming runs on its own instructions rather than the conversation's:

```
You name conversations. Reply with the title text only: no preface, no explanation, no quotation marks, no markup, no code fences, and no tool calls. You have no tools.
```

Sending the chat persona made the model answer this call the way it answers a
turn — with a preamble, a code fence, or a tool call it had no tools to make —
and every one of those reached the sidebar as the conversation's name. It also
paid for the whole persona on every new conversation. The user prompt template,
carrying the opening message (and the assistant's reply, where one is passed)
capped at 2 000 characters each:

```
Title only the conversation below. Ignore the system message, model identity, provider names, and tool names when choosing the title. Return only a concise title in the conversation's language, at most 5 words.

{convo}
```

Whatever comes back is reduced to one short line: control tokens, code fences,
tags and a leading `Title:` label are stripped, surrounding quotes and trailing
punctuation go, and anything past 60 characters is cut at the first clause
boundary rather than mid-word. An answer that still reads as tool-call markup or
call syntax is discarded whole — and the markup is tested for before anything is
stripped, because `<path>/etc/passwd</path>` looks like an ordinary title once
its tags are gone.

Discarding leaves nothing, and nothing is a real answer here: the conversation is
then named from the user's own opening line, shortened by exactly the same rules.
That is a fallback rather than the mechanism. Truncation alone was the regression
this call exists to undo, but a fragment of the user's question beats a fragment
of tool-call syntax, and it beats a conversation that stays called "New
conversation" because one model answered a naming request with a preface.

## Run lifecycle

A run is a server-side object that outlives every client connection.

```
queued → running → completed | failed | cancelled
```

- `POST .../runs` returns `202` immediately with `runId` and the current event
  watermark. The agent starts in the background.
- A run opens an operation on the lane, and closes it with its outcome. A hard
  restart therefore leaves an operation open, which the next run in that
  conversation closes as `failed` — the counterpart to `failStaleRuns` for the
  tree. The lane refuses to start a second operation while one is open, so
  skipping this would brick the conversation.
- Preparation — adopting an older transcript, then compacting — happens after the
  run is registered, so `stop` works while it is still summarizing.
- Every event, deltas included, is written to `events` and then broadcast, so a
  reconnect is one query rather than a choice between two sources.
- `stop` aborts the agent; the partial assistant message is still persisted.
- `steer` injects a user message into the running loop, one at a time.
- Two minutes after the run settles its deltas are pruned and the pages reclaimed.
  A late subscriber replays the durable events, which are what the transcript is
  made of anyway (`00-architecture.md §Event durability`).

Tool execution is parallel within a step. The tool list is assembled in a fixed
order — file search, web, code, generation, MCP, memory, skills — and MCP servers
keep their configured order within that, because reordering the list invalidates
the provider's prompt cache.

## What must be tested

These are the assertions that catch alignment drift:

- The stable block is byte-identical across two consecutive turns of one
  conversation, and only the volatile tail moves when the clock does.
- Prompt section order: web contract, prompt pair with identity substituted,
  skills, memory guard, then the runtime clock, the file list and the memory
  block.
- A skill's body never appears in the prompt, only in the result of the
  `use_skill` call that asked for it.
- The memory block matches the format string in `03-tools.md §3` exactly,
  including the ` [N tokens]` segment and its omission.
- `intent` is the first key of every native tool schema.
- Tool schema token counting happens after `intent` injection.
- A conversation exceeding the budget drops at user-message boundaries and never
  splits a turn.
- A compacted conversation sends the summary to the model, and the summary
  survives both the LLM conversion and the pruning fallback.
- After a rewind the reader's transcript and the model's context are identical,
  and the abandoned turn is still in the tree.
- A transcript written before the session store is adopted into the tree exactly
  once, and adoption is idempotent.
- No persisted message contains a base64 payload.
- A run that settled more than two minutes ago has no `message.delta` rows left,
  and every terminal event it produced is still there.
- Title generation issues a second, separate provider call on turn one and none
  on turn two, and that call is sent the naming prompt rather than the
  conversation's.
- A naming answer that is markup, a tool call or empty leaves the conversation
  named from the user's own opening line, never from a fragment of the answer.
