# HTTP and streaming contract

Base path `/v1`. JSON in, JSON out, UTF-8. This document is the source of truth
for `src/shared/types.ts`, which both the server and every client import.

The web bundle is served from `/` and is a client like any other. It gets no
privileged endpoint.

## Conventions

**Auth.** Every route except `/v1/health` and `/v1/auth/token` requires a device
token, sent either as `Authorization: Bearer <token>` or in the `luma_token`
`HttpOnly` cookie. Native clients use the header; the web client uses the cookie
so a stolen `localStorage` cannot leak it. Both resolve to the same `devices` row.

**Errors.** Always the same envelope, never a bare string:

```json
{ "error": { "code": "model_not_configured", "message": "CometAPI has no API key." } }
```

`code` is a stable machine-readable identifier and `message` is safe to display
verbatim. A third member, `details`, is reserved for structured context a client
could branch on; no route sets it today, so it is absent from every current
response and a client must not require it. Status codes: 400 validation, 401
no/invalid token, 403 revoked, 404, 409 conflict (e.g. a run already active),
422 capability not configured, 500.

**Pagination.** List endpoints take `?limit=` and return
`{ items: [...], nextCursor: T | null }`, where `nextCursor` is what to pass
back to get the next page and `null` means there is none. The cursor's type is
whatever that collection is ordered by, and so is the parameter it goes back in:
`?cursor=` for conversations (an `updatedAt` stamp), `?before=` for messages (a
sequence number), `?offset=` for the file library and the gallery. A client should
treat the value as opaque and echo it rather than compute it.

**Timestamps.** Unix milliseconds, integers.

**Idempotency.** Any POST that creates work accepts an `Idempotency-Key` header.
Replaying a key returns the original resource rather than creating a second one.
This is what makes a phone safe to retry on a dropped connection.

## Auth

```
GET    /v1/auth/challenge                                  → { totpRequired, lockedFor }
POST   /v1/auth/token   { accessCode, totp?, deviceName }  → { token, expiresAt }
POST   /v1/auth/logout                                     → 204
GET    /v1/health                                          → { ok, version }
```

The token is returned exactly once. For browser clients the server also sets the
cookie; native clients store the value in the Keychain.

`GET /auth/challenge` lets the sign-in form ask for the second factor up front
rather than learning about it from a rejected attempt. When two-factor sign-in is
enrolled, `POST /auth/token` without `totp` answers `401 totp_required`, which is
a prompt rather than a failure and is not counted against the attempt budget.

Failed attempts are limited per client address (eight in fifteen minutes) and
across all addresses (forty), after which further attempts answer `429` for
fifteen minutes. The global budget is deliberately much looser so it cannot be
used to lock the owner out.

## Security

```
GET    /v1/security                        → SecuritySettings
PUT    /v1/security/access-code            { value } → SecuritySettings
POST   /v1/security/totp                   → { secret, uri }
POST   /v1/security/totp/confirm           { code } → SecuritySettings
DELETE /v1/security/totp                   { code } → SecuritySettings
DELETE /v1/security/sessions/:id           → SecuritySettings
POST   /v1/security/sessions/revoke-others → SecuritySettings
```

Enrolling a second factor is two steps: `POST /security/totp` returns a secret
that is held aside, and only a correct code from `/confirm` adopts it. A
mis-scanned QR therefore cannot lock the owner out of their own server.
Disabling it needs a current code too, so a hijacked session cannot quietly
remove the factor.

Changing the access code revokes every other session, which makes rotation after
a suspected leak one action instead of a cleanup. A session is identified by the
hash of its token: enough to list and revoke, useless as a credential.

Cookie-authenticated writes additionally require a same-origin `Origin` header;
see `05-remote-access.md` for the full deployment posture.

## Bootstrap

```
GET /v1/bootstrap → {
  version:        string,
  models:         Model[],
  providers:      Provider[],
  defaultModelId: string,
  profiles:       Profile[],
  defaultProfileId: string,
  capabilities:   Capabilities,
  mcp:            McpStatus[],
  prompts:        { globalPrompt, toolPrompt, titleModelId, titleEnabled },
  memoryKeys:     string[],
  limits:         { maxUploadBytes: number, maxAttachmentsPerMessage: number }
}
```

Everything needed to render settings and to start a run, in one round trip.
`capabilities` is the same object `GET /v1/capabilities` returns, keyed by
capability rather than a list.

It deliberately does **not** carry conversations: the list is paged and changes
far more often than settings do, so a cold start is two calls — this and
`GET /v1/conversations?limit=`. Nor does it carry memory usage; that is on
`GET /v1/memory`.

## Conversations and messages

```
GET    /v1/conversations[?limit=&cursor=]   → paged ConversationSummary
POST   /v1/conversations                    { modelId?, profileId?, title? } → Conversation (201)
GET    /v1/conversations/:id                → Conversation & { activeRun: Run & { resumeSeq } | null }
PATCH  /v1/conversations/:id                { title?, modelId?, profileId? }
DELETE /v1/conversations/:id                → 204

GET    /v1/conversations/search?q=<text>[&limit=<n>]       → { items: ConversationSearchHit[] }

GET    /v1/conversations/:id/messages?after=<seq>          → { items, nextCursor: null }
GET    /v1/conversations/:id/messages?limit=<n>[&before=<seq>]
                                            → { items, nextCursor: number | null }
```

The path answers two different questions, because clients ask both about the
same resource.

`after` is *what changed since I last looked*: every message with a higher
sequence, oldest-first, and `nextCursor: null` because there is nothing beyond
"now". This is how a client tops up a conversation it is already showing, and
it is what the web UI uses.

`limit` is *give me the end of this transcript*, which is what a client opening
a conversation for the first time needs — a phone should not pull a
two-thousand-message history to render one screen. It returns the newest
`limit` messages, still oldest-first, plus a `nextCursor`. Pass that cursor back
as `before` for the page before it; `nextCursor: null` means the start of the
conversation has been reached. `limit` is capped at 500.

A page is extended backwards to the user message that begins the turn it lands
in, so a page never opens on a tool result whose call is on the page before it.
That means a page can be slightly larger than `limit`; it is never smaller
except at the start of the conversation.

Sequence numbers are per-conversation and dense, but a rewind (`fromSeq`)
reuses them, so a client that edits or regenerates must refetch rather than page
across the rewind.

`activeRun` on the single-conversation read is what makes reattaching one round
trip instead of a guess: it carries the run to resume and `resumeSeq`, the last
event already persisted into the transcript. A client that has just fetched the
messages streams from there rather than from its own high-water mark, so it
replays nothing it already has and misses nothing it does not.

`profileId` picks the named bundle the conversation runs under — its chat, image
and video models, which capabilities and MCP servers are offered, and its prompt
pair (`07-generation.md §Profiles`). Omitting it on create uses the default
profile; a deployment with no profiles behaves exactly as one with none ever did,
which is what keeps the field inert on existing data.

### Search

```
{ conversationId, title, seq, role, snippet, createdAt }
```

One entry per matching message, best match first, `limit` capped at 50. A blank
`q` is not an error; it returns an empty list, which is what a client clearing its
search box wants.

The index is SQLite FTS over the session trees, provided by the session backend,
with a trigram tokenizer — so a CJK query with no word breaks matches, and so does
a substring. Search is deliberately answered from the tree rather than from
`messages`: it is the tree that has every message.

A hit is only returned when it is on the conversation's current branch, because
`seq` has to name a place a client can actually open; a message on an abandoned
branch is still in the tree and still findable by other means, but a client has
nowhere to scroll to. Hits that matched only the payload's structure rather than
its readable text are dropped for the same reason.

## Runs

```
POST /v1/conversations/:id/runs
     Idempotency-Key: <uuid>
     { text, attachments?: string[], modelId?, fromSeq? }
  → 202 { runId, seq }          -- seq is the event cursor to stream from

POST /v1/conversations/:id/continue → 202 { runId, seq }
POST /v1/conversations/:id/stop     → 204
POST /v1/conversations/:id/steer    { text } → 204
GET  /v1/runs/:id                   → Run
```

`seq` in the response is the watermark before the run produced anything, so a
client can start streaming without racing the first event.

`stop` aborts the agent. `steer` injects a user message into an in-flight run
(`steeringMode: "one-at-a-time"`).

### Editing, regenerating and continuing

`fromSeq` rewinds the conversation to just before that message and then starts the
run, which is the whole of both *edit* and *regenerate*: editing sends new text at
the old message's sequence, regenerating sends the original text back. Under the
API this moves the session tree's branch pointer and re-projects the transcript
from there, so the abandoned turns survive on disk while no client is ever offered
a fork to reconcile (`01-data-model.md §Transcripts`). The rewind runs only after
the model resolves, so a request naming a model that cannot be reached leaves the
history intact.

Because the client's incremental fetch is keyed on sequence numbers that a
rewind reuses, a client that sends `fromSeq` must refetch the transcript from the
beginning rather than topping up.

`continue` picks the answer back up. A stopped run persists its partial answer
with `stopReason: "aborted"`, so the transcript ends on an assistant message and
the agent loop cannot resume from it; the endpoint therefore sends a short
continuation instruction as an ordinary user message, visible in the transcript
like anything else the reader could have typed. Only a run that died between a
tool result and the next model call resumes silently, with no added turn.

### Streaming

```
GET /v1/runs/:id/events?after=<seq>        → text/event-stream
GET /v1/runs/:id/events?after=<seq>&mode=poll → { events: Event[], done: boolean }
```

Both take the same cursor and return the same event objects. A client may switch
between them freely — the phone streams in the foreground and polls after iOS
suspends and resumes it.

SSE frames carry the whole stored event as `data`, so a client parses one shape
whether it streamed the event or polled for it:

```
id: 1841
event: tool.execution.start
data: {"seq":1841,"runId":"run_…","conversationId":"conv_…","type":"tool.execution.start","data":{…},"createdAt":1750000000000}

event: heartbeat
data:
```

A heartbeat goes out every 15 seconds. Cloudflare closes idle tunneled
connections and iOS drops them faster; without this the stream dies silently
mid-generation.

`Last-Event-ID` is honoured as an `after` fallback for clients using a stock
`EventSource`.

Event types, with the contents of the inner `data` object:

| Type | Retained | `data` |
|---|---|---|
| `run.started` | yes | `{ modelId, model }` |
| `message.delta` | pruned | `{ assistantMessageEvent: { type: "text_delta" \| "thinking_delta", delta } }` |
| `message.end` | yes | `{ message }` — the finalized `AgentMessage` |
| `tool.execution.start` | yes | `{ toolCallId, toolName, args }` |
| `tool.execution.end` | yes | `{ toolCallId, toolName, isError, result }` |
| `tool.approval.required` | yes | `{ approval }` — see below |
| `tool.approval.resolved` | yes | `{ approval }` |
| `job.progress` | pruned | the `JobRecord` of a generation this turn started |
| `context.compacted` | yes | `{ summary, tokensBefore }` — emitted before the model is called, when this run had to summarise older turns to fit |
| `conversation.title` | yes | `{ title }` |
| `run.completed` / `run.failed` / `run.cancelled` | yes | `{ message? }` |

Every event also carries `modelCallIndex` — which model call within the run
produced it — and, on the tool events, `toolCallIndex`. They exist so a client can
group a turn's events without inferring order from arrival, and they are on the
inner `data` object alongside the fields above.

`args.intent` on `tool.execution.start` is the sentence the model wrote as its
first tool argument, e.g. `Searching for the recommended sampler`. Clients
display it as the live status line. It replaces hand-written status strings.

Deltas are written to the log like everything else — a polling client reads in
bursts and would otherwise miss the text of a short answer entirely — and are
pruned two minutes after the run settles. So reconnecting to a run that finished
recently replays its deltas, and reconnecting to an old one yields only the
persisted transcript: complete, minus the token-by-token animation.

## Approvals

A destructive coding tool call does not run until a person says so. The model
cannot authorise itself; there is no argument it can pass and no policy that
lets a run proceed unattended.

What is held: deleting a file, deleting a directory recursively, overwriting an
existing file, moving or renaming a path, and *every* shell command. Reading,
searching, listing, patching an existing file, creating a new one and restoring
a backup are never held. Classification happens on the server from the validated
arguments and the actual state of the disk, so a model cannot dodge it by
mislabelling its own call.

The shell rule used to be a list of a dozen patterns — `rm`, `Remove-Item`,
`git reset --hard`, redirection over a file, and so on. A pattern list is a
guess about a language designed to have infinitely many spellings for the same
act: `rm` is caught but `find -delete` is not, and `$(printf '\x72\x6d')` is not
either. It also gives false comfort, since the gate looks thorough. A shell is
an arbitrary-effect tool; the honest classification is that all of it is
arbitrary. Every command is shown before it runs.

```
GET  /v1/conversations/:id/approvals[?status=all]  → { items: Approval[] }
GET  /v1/approvals                                 → { items: Approval[] }  -- every pending, any conversation
POST /v1/approvals/:id  { approved: boolean }      → Approval
```

```ts
interface Approval {
  id: string;            // the tool call id, or a minted one when that is not unique
  runId: string;
  conversationId: string;
  toolName: string;      // delete_path, move_path, write_file, bash_tool
  action: string;        // delete, delete_recursive, move, move_overwrite, overwrite, shell
  summary: string;       // one sentence naming exactly what will happen
  detail: Record<string, unknown>;  // paths, file counts, byte totals, recoverable
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: number;
  updatedAt: number;
}
```

The state machine has one transition and it is final. `pending` moves to
`approved` or `rejected` by the POST, or to `expired` when the run ends or 15
minutes pass with no answer. A settled row ignores further decisions and the
endpoint returns the settled state, so a double-tap, a retried request and two
browsers deciding at once all converge instead of racing. Silence never becomes
approval.

The row is the source of truth, not the stream. A client that was closed when
the question was asked will find nothing to replay, so it fetches the pending
list on open; a client that was streaming sees `tool.approval.required` and then
`tool.approval.resolved` with the same id. Both are answering the same row, and
the id is the tool call id, so the card sits exactly where that tool's block
will appear.

A rejection reaches the model as an ordinary failed tool result explaining that
a person refused and that it should not retry — not as a crash, and not as
silence that looks like success.

Approvals pending when the process dies are expired at startup, because the tool
call that was waiting for them no longer exists.

## Settings

```
GET   /v1/providers                       → Provider[]
POST  /v1/providers                       { name, baseUrl, apiKey?, auth? } → Provider (201)
PATCH /v1/providers/:id                   { name?, baseUrl?, enabled?, auth? }
DELETE /v1/providers/:id                  → 204   -- also drops its models and key
PUT   /v1/providers/:id/key               { value }  → 204   -- write-only
DELETE /v1/providers/:id/key              → 204
GET   /v1/providers/:id/models            → { items: DiscoveredModel[] }  -- live GET /models

GET   /v1/models                          → { items: Model[], defaultModelId }
POST  /v1/models                          { providerId, model, name, apiMode, kind?, ops?, params?, … } → Model (201)
POST  /v1/models/bulk                     { providerId, models: ModelInput[] } → { added, skipped }
PATCH /v1/models/:id                      { name?, apiMode?, kind?, ops?, params?, contextWindow?, maxTokens?, thinkingLevel?, systemPrompt?, enabled?, pinned?, pricing? }
PUT   /v1/models/default                  { modelId } → { defaultModelId }
DELETE /v1/models/:id                     → 204

GET   /v1/profiles                        → { items: Profile[], defaultProfileId }
POST  /v1/profiles                        ProfileInput → Profile (201)
PATCH /v1/profiles/:id                    partial ProfileInput → Profile
DELETE /v1/profiles/:id                   → 204
PUT   /v1/profiles/default                { profileId } → { defaultProfileId }   -- "" clears it

GET   /v1/capabilities                    → Capabilities
PATCH /v1/capabilities                    partial Capabilities  → Capabilities
PUT   /v1/capabilities/secrets/:name      { value } → Capabilities
DELETE /v1/capabilities/secrets/:name     → Capabilities

GET   /v1/mcp/servers                     → { items: McpServer[], status: McpStatus[] }
POST  /v1/mcp/servers                     { title, command?, args?, env?, url?, headers? } → McpServer (201)
PATCH /v1/mcp/servers/:id                 same fields, all optional → { items, status }
DELETE /v1/mcp/servers/:id                → 204
POST  /v1/mcp/reconnect                   → { status: McpStatus[] }

GET   /v1/prompts                         → PromptSettings
GET   /v1/prompts/defaults                → { globalPrompt, toolPrompt }
PUT   /v1/prompts                         partial PromptSettings → PromptSettings
```

`/prompts/defaults` is the pair the build ships with, which is what makes an
edited prompt reversible. The stored copy is written once, at seed time, so an
install that predates a change to the recommended prompt keeps its own text —
correct, since it may have been edited on purpose, but it also means the only way
back is to be told what the current default says.

`PromptSettings` is `{ globalPrompt, toolPrompt, titleModelId, titleEnabled }`:
the two halves of the prompt pair (`04-agent.md §Prompt assembly`), plus which
model writes conversation titles and whether it does at all. An omitted field
keeps its stored value; an empty string is a real value and clears it.

`apiMode` is the wire protocol (`openai-chat`, `openai-responses`,
`anthropic-messages`, plus the generation protocols `openai-images`,
`venice-image`, `comfy-workflow`, `openai-videos`) and belongs to the model rather
than the provider, because an aggregator exposes several of them under one base
URL. For `anthropic-messages` the stored base URL has a trailing `/v1` stripped,
since the Anthropic client appends `/v1/messages` itself.

`kind` says what a row is for — `chat`, `image`, `video`, `embedding`, `rerank` —
and it, not `apiMode`, decides where a model may be used: only a chat kind enters
the pi-ai provider graph and the chat switcher, while a generation kind is offered
in the studio and as an agent tool. `ops` narrows what a generation row does
(`text_to_image`, `image_to_image`, `text_to_video`, `image_to_video`) and can
never exceed what its adapter implements; `params` is that adapter's own
declaration, such as a ComfyUI workflow's node bindings. See `07-generation.md`.

`enabled` and `pinned` are two different questions. `enabled` decides whether a
model can be used at all; `pinned` decides whether it appears in the chat
switcher. An aggregator offers hundreds of models and a person reaches for four,
so bulk-added models arrive unpinned and are promoted one at a time.

`GET /providers/:id/models` returns the live catalogue annotated for that
choice: whether a model is already configured, and a suggested id, name, kind,
ops, API mode, reasoning flag and input set inferred from the remote id. For a
provider whose image catalogue lives behind its own query — Venice's
`?type=image` — the probe asks the extra questions and merges the answers, since
one `GET /models` would report a drawing service as having nothing to draw with.
A suggestion is a starting point that stays editable — it exists to avoid filling
six fields a dozen times, not to be authoritative.

The model editor exposes the fields the LibreChat `modelSpec` presets used, plus
pricing and temperature — temperature because a gateway occasionally needs one
sent explicitly. It is empty by default and an empty field sends nothing. `top_p`
is stored and applied the same way but has no control, and the other fifteen
parameters LibreChat surfaced are absent entirely, because they were never set.

Any capability or MCP change reconnects the pool. A server that is disabled for
chat but listed in `studio.servers` still gets a connection; its tools are served
to the studio only and never reach the agent's tool list.

Writing or clearing a secret returns the whole `Capabilities` object, not 204,
because a key is what makes a capability usable: the flags a settings screen
renders change as a side effect of the write, and returning them closes that gap
in the same round trip. `PATCH /mcp/servers/:id` returns `{ items, status }` for
the same reason — an edit triggers a reconnect, and the status is the only place
a failed launch shows up.

A provider's `auth` says how its credential is presented: absent or null is
`Authorization: Bearer`, `{"style":"header","header":"x-api-key","prefix":""}`
puts it in a header of your choosing, and `{"style":"none"}` sends none at all,
which is what a self-hosted Ollama, llama.cpp or vLLM wants. On a `PATCH` the
field is carried as sent — omitting it keeps the stored style, and an explicit
null is how a provider goes back to bearer.

An MCP record is a subprocess or a remote server depending on which of `command`
and `url` it carries, and one of the two is required. Sending the other as an
empty string is how a record changes sides; header values go through the same
`${VAR}` expansion as `env`.

## Files

```
GET    /v1/files?kind&source&q&limit&offset
                                          → { items: FileRecord[], total, facets }
POST   /v1/files                          multipart: file, conversationId?
                                          → FileRecord
POST   /v1/files/notes                    { name, text } → FileRecord
GET    /v1/files/:id                      → FileRecord
GET    /v1/files/:id/content              → bytes
GET    /v1/files/:id/text                 → { id, name, text }
PUT    /v1/files/:id/text                 { name, text } → FileRecord
POST   /v1/files/:id/reindex              → FileRecord
DELETE /v1/files/:id                      → 204
POST   /v1/files/search                   { query, mode?: "semantic"|"keyword"|"hybrid", limit? }
                                          → { mode, results: SearchHit[], index }

GET    /v1/images/:imageId?w=320          → bytes (WebP thumbnail when `w` is given)
GET    /v1/videos/:videoId                → bytes, honours `Range`
```

One library holds everything the user owns: uploads, notes written in the app,
and images produced by a tool. `kind` filters documents against images, `source`
filters by provenance (`upload`, `generated`, `note`, `librechat`), and `q`
matches the filename. Filtering happens in SQL because the library is mostly
generated images — several hundred rows — and shipping all of them so the
browser can filter would defeat the point.

`facets` carries the count for each value of one filter with the *other* filters
applied, so the number on a chip is what clicking it will show.

`POST /v1/files` is content-addressed for documents: an upload whose bytes are
already in the library answers with the row that holds them rather than opening a
second one, so a client that re-sends the same PDF gets back the id it had before
and no second copy is chunked, embedded and retrieved
(`01-data-model.md §Files, chunks, vectors`). Images are deliberately exempt, and
a re-uploaded image really does get a new row: an image's id is also the handle
for its `image_assets` row, its metadata sidecar and its thumbnail cache, so
collapsing two of them would save one file and dangle three references.

`POST /files/notes` writes a Markdown document into the same library and the same
index as an upload; `PUT /files/:id/text` rewrites one and reindexes it. Notes
are the only files editable in place, since rewriting a PDF or an image in a
textarea is not a thing.

`GET /v1/images/:imageId` serves both uploaded and tool-generated images and is
the only path the UI uses for anything image-shaped. Without `w` it returns the
original; with `w` it returns a cached WebP resized to that width, which is what
makes the gallery and the file library cheap to open — 350 image rows cost about
50 KB of thumbnails instead of hundreds of megabytes of originals. Responses are
immutable and long-cached, so a revisit costs nothing.

`GET /v1/videos/:videoId` answers a `Range` request with `206` and the asked-for
slice, because a browser scrubbing a timeline sends one and a server that ignores
it makes every seek download the whole file again.

A tool writes image bytes into the asset directory before Luma knows anything
about them, so the directory is indexed in memory rather than scanned per
request, and the index is invalidated when a tool writes a new image. The image
is then *adopted*: it gets a `files` row with `source: "generated"`, which is
what puts it in the library alongside uploads. Startup adopts anything produced
by an older build and prunes rows whose file has disappeared, so the gallery
cannot show broken tiles.

`POST /v1/files/search` is the same retrieval path the `file_search` tool uses,
so the library and the agent can never disagree about what is findable. An
omitted `mode` falls back to the configured default, and the response echoes the
`mode` actually used along with `index` — `{ total, ready }` over the non-image
library, so a client can see how many documents are embedded out of how many
exist. That is there because "no results" and "nothing indexed yet" look
identical otherwise, and only the second one is worth waiting out.

## Studio

```
GET    /v1/studio/tools                   → { items: StudioTool[], enabled }
GET    /v1/studio/gallery?limit&offset    → { items: StudioImage[], total, offset, limit }
POST   /v1/studio/run                     { serverId, tool, args }
                                          → { jobId?, imageId? | videoId?, mime, width, height,
                                              durationMs?, provider, model, elapsedMs }
```

The studio calls generation directly, bypassing the agent loop, so a deliberate
generate-or-edit does not pay for a model turn. Every tool is described by a JSON
Schema and the form is generated from it, which means a new backend shows up in the
UI without any client change.

Two things feed the list. A generation model contributes one entry per operation
under the id `model:<modelId>`, with `modelId` and `op` on the entry and its form
taken from the adapter's schema — the same schema the agent's tool advertises. MCP
servers contribute their own tools, with those classified `other` hidden since only
generate, edit and video make sense here. From the user's side both are just "make
a picture"; the difference only shows up in which settings screen adds them.

`POST /studio/run` is synchronous even though generation is a queue underneath: it
submits a job, waits, and answers with the asset, because a client that wants one
picture should not have to learn the queue. A video answers with `videoId` and
`durationMs` where an image answers with `imageId`. Bytes are saved through the
same path either way — asset directory, sidecar, provenance, library row — so the
result can be edited, browsed and deleted identically.

## Jobs

```
GET    /v1/jobs?status&conversationId&limit  → { items: JobRecord[] }
POST   /v1/jobs                           JobInput → JobRecord (202)
GET    /v1/jobs/:id                       → JobRecord
POST   /v1/jobs/:id/cancel                → JobRecord
GET    /v1/jobs/:id/events                → SSE: job.queued | job.running
                                                 | job.succeeded | job.failed | job.cancelled
```

Generation runs as jobs so a video that takes minutes is not an HTTP request held
open. A job's entire state is one row, which is why the stream carries no cursor
and no `Last-Event-ID`: it opens with the current row, sends the row again on every
change, ends on a settled status, and a client that misses all of it gets the same
answer from `GET /v1/jobs/:id`. Heartbeats every fifteen seconds keep a proxy from
closing an idle render.

## Memory

```
GET    /v1/memory              → snapshot
PUT    /v1/memory/:key         { value } → snapshot
DELETE /v1/memory/:key         → snapshot
```

The snapshot is `{ items: MemoryEntry[], tokens, limit, charLimit, suggestedKeys }`.
Writes and deletes return it rather than the single row they touched because the
budget is what a client has to render: `tokens` against `limit` moves on every
edit, so returning the whole picture saves a follow-up read and cannot show a
stale bar. `charLimit` is the per-value ceiling a write is rejected against.

A key is anything matching `^[A-Za-z0-9_-]{1,64}$`. `suggestedKeys` is what a
client offers first and what the tool description shows the model; it is a
starting vocabulary, not a whitelist. The seven names were once enforced, which
meant a user who wanted their dog's name remembered had to have it filed under
`personal` or not at all — the constraint did not prevent bad memory, it only
prevented accurate labels. What actually bounds the store is the token budget.

## Rejected alternatives

**WebSocket instead of SSE.** SSE plus a poll fallback covers the same ground
with less machinery: no framing protocol, no reconnect handshake, and resume is
just an integer cursor. Steering is rare enough that a plain POST is fine, so
the bidirectional channel a WebSocket buys would go unused.

**Long-lived run tokens in the URL.** Would make sharing a stream URL possible
but puts credentials in logs. Device token in the header or cookie instead.

**GraphQL.** Nine resources with obvious shapes. The bootstrap endpoint already
solves the round-trip problem that would justify it.
