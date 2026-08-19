# Data model

The `CREATE TABLE` blocks below are copied from `src/server/store/schema.sql`
deliberately, and they are not a relay that can go stale: `npm run audit` parses
both and fails on any column that differs, so the prose beside each table is
attached to a definition that is checked rather than remembered. Change the
schema without changing this file and the audit says so by name.

Two SQLite databases, both opened with `node:sqlite`:

- `data/luma.sqlite` — everything below.
- `data/sessions.sqlite` — the conversation trees, owned by
  `@earendil-works/pi-session-backend-sqlite-node`. It gets its own file because
  that package owns its schema and migrations, and its `sessions` table would
  collide with the device-session table here.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA auto_vacuum = INCREMENTAL;      -- deltas are pruned continuously; see Maintenance
PRAGMA journal_size_limit = 16777216;  -- a checkpointed WAL keeps its high-water mark otherwise
PRAGMA busy_timeout = 5000;            -- a tool call and an HTTP write can arrive together
```

There is no version counter and no numbered migration files. `schema.sql` is
`CREATE TABLE IF NOT EXISTS` throughout and runs on every start, and the few
columns added after the fact are applied by a forward-only pass that asks
`PRAGMA table_info` what is missing. A new table therefore costs one statement in
`schema.sql`; a new column on an old table costs one guarded `ALTER`. Nothing is
ever dropped, because the file holds the user's conversations.

## Configuration and identity

```sql
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON
  updated_at  INTEGER NOT NULL
);

-- AES-256-GCM, key from data/master.key. Values are write-only over the API.
CREATE TABLE secrets (
  name        TEXT PRIMARY KEY,           -- "provider:cometapi", "tavily", "embeddings"
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,            -- SHA-256 of the bearer token
  device     TEXT NOT NULL DEFAULT 'web', -- "Safari · macOS", "iPad"
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The server's own bookkeeping, kept apart from `settings` because nothing here
-- is a user's choice: today it holds the seed version, so a fresh install gets
-- the recommended providers and models exactly once.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Only the hash of a session token is stored, so a copy of the database does not
hand over live sessions. Revoking is a delete; the row is the session.

The access code is a `secrets` row named `access-code`, compared with a
timing-safe equality check. When two-factor is on, `totp` holds the confirmed
Base32 shared secret and `totpPending` holds one that has been shown as a QR code
but not yet proven with a correct code — enrolment only replaces `totp` once the
user has demonstrated their authenticator actually works, so a mis-scanned setup
cannot lock them out.

## Providers and models

Mirrors what `librechat.yaml` expressed as `endpoints.custom` plus `modelSpecs`,
minus the twenty parameters that were never set.

```sql
CREATE TABLE providers (
  id          TEXT PRIMARY KEY,           -- "cometapi"
  name        TEXT NOT NULL,              -- "CometAPI"
  base_url    TEXT NOT NULL,
  auth        TEXT,                       -- {"style","header","prefix"}; null means bearer
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
-- API key lives in secrets under "provider:<id>".

CREATE TABLE models (
  id                 TEXT PRIMARY KEY,    -- "cometapi:claude-opus-4.6"
  provider_id        TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,       -- display name
  model              TEXT NOT NULL,       -- wire name sent to the provider
  api_mode           TEXT NOT NULL,       -- wire protocol: openai-chat | anthropic-messages | comfy-workflow | …
  kind               TEXT NOT NULL DEFAULT 'chat',   -- chat | image | video | embedding | rerank
  ops                TEXT NOT NULL DEFAULT '[]',     -- generation operations this row may run
  params             TEXT,                -- adapter-specific declaration (workflow bindings, sizes)
  librechat_compat   INTEGER NOT NULL DEFAULT 0,
  context_window     INTEGER NOT NULL,
  max_tokens         INTEGER NOT NULL,
  reasoning          INTEGER NOT NULL DEFAULT 0,     -- thinking is available at all
  thinking_level     TEXT NOT NULL DEFAULT 'off',
  thinking_level_map TEXT,                -- per-model override of the level → wire value mapping
  input              TEXT NOT NULL DEFAULT '["text"]',
  system_prompt      TEXT,                -- per-model system prompt; replaces the global one
  enabled            INTEGER NOT NULL DEFAULT 1,
  pinned             INTEGER NOT NULL DEFAULT 1,  -- shown in the chat switcher
  agent_tool         INTEGER NOT NULL DEFAULT 0,  -- generation only: agent gets a tool named after it
  temperature        REAL,                -- both null unless the model needs them
  top_p              REAL,
  pricing            TEXT,                -- $/1M, LibreChat tokenConfig equivalent
  compat             TEXT,                -- pi-ai compat flags, e.g. forceAdaptiveThinking
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX models_provider ON models(provider_id);
```

The wire protocol is a property of the model, not the provider: aggregators like
CometAPI serve OpenAI-shaped and Anthropic-shaped endpoints from one base URL, so
`api_mode` has to be settable per model. `librechat_compat` keeps the few payload
quirks LibreChat sent (and some upstreams now depend on) behind an explicit flag
instead of spreading provider-name checks through the request builder.

How the credential is *presented* is data on the provider row for the same
reason. `Authorization: Bearer` is the default and what almost every
OpenAI-compatible endpoint wants, so `auth IS NULL` behaves exactly as it always
did; `{"style":"header","header":"x-api-key","prefix":""}` covers the relay
stations and Azure-shaped gateways that read their own header, and
`{"style":"none"}` is a self-hosted Ollama or vLLM that authenticates nobody —
which is also what stops "no API key configured" from refusing a model that never
wanted one. Anything unrecognised in that JSON reads as bearer, because the
column is edited from a client.

One table holds everything callable, chat or not, because provider, key,
enablement, ordering and naming are already solved here and a second table would
fork all of it. `kind` is what separates them, and the chat-only columns —
`context_window`, `thinking_level`, `temperature` — are simply unused by a drawing
row (`08-generation.md §Models grow a kind`).

`enabled` and `pinned` separate "may be used" from "is one click away". Adding a
provider's whole catalogue is one action, so the switcher would otherwise become
a hundred-item list; bulk-added models land unpinned and get promoted
individually. A conversation already running on an unpinned model still shows it,
because hiding the model you are currently talking to is worse than a slightly
longer list.

`agent_tool` is the same separation on the generation side, and defaults the
other way. The agent is handed three generation tools bound to the profile's
chosen models, not one per row, because tool schemas are re-sent every turn;
setting the flag buys a named tool for that backend at that recurring cost
(`08-generation.md §What the model calls`).

## Conversations, messages, runs

```sql
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  model_id   TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT '',     -- '' means the deployment's own settings
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversations_updated ON conversations(archived, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,       -- per conversation, 1-based
  role            TEXT NOT NULL,          -- "user" | "assistant" | "toolResult"
  content         TEXT NOT NULL,          -- JSON content parts, images as image_ref
  entry_id        TEXT,                   -- the tree entry this row is projected from
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_order ON messages(conversation_id, seq);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,          -- queued | running | completed | failed | cancelled
  model_id        TEXT NOT NULL,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX runs_conversation ON runs(conversation_id, created_at DESC);
```

A run row is lifecycle only. Token usage is not copied here because the session
tree already records it per turn, and `Idempotency-Key` is held in memory rather
than in a column: a retry follows a dropped POST within seconds, so the window
only has to outlive a reconnect (`03-api.md §Runs`).

### Transcripts

`messages` is a **projection**, not the source of truth. The truth is the
conversation's session tree in `data/sessions.sqlite`: an append-only log of
entries (messages, compactions, branch summaries) plus a record log (operations,
tool starts, token usage), with a lane named `main` marking the current branch.

The projection holds the message entries on that branch, in branch order, with
`entry_id` pointing back at the entry each row came from. That pointer is what
turns a client sequence number into a place in the tree, which is how a rewind
knows where to move the branch to. Clients read only the projection, so the API
in `03-api.md` is unaffected by any of this.

Why a tree at all: a flat list cannot express a rewound turn that is still
recoverable, history that has been summarized rather than deleted, or what each
turn cost. All three are things a complete agent needs, and all three are
answered by upstream code rather than by ours.

Conversations written before the tree existed have `entry_id IS NULL`; the first
run replays those rows into the tree once, and afterwards they are ordinary
projected rows. Deleting a conversation must delete its tree too.

Search is answered from the tree as well. The session backend keeps an FTS5 index
over entry payloads inside `sessions.sqlite`, maintained by triggers, so the
server's own writes keep it current; `messages(entry_id)` is indexed here because
resolving a hit back to a row on the current branch is what makes it openable
(`03-api.md §Search`).

### Events

One table for everything a client can be told, live or on reconnect. The
difference between an event that lasts and one that does not is when it is
deleted: `message.delta` and `job.progress` are transient and pruned shortly
after their run settles, everything else is kept
(`01-architecture.md §Event durability`). Pruning plus incremental vacuum is what
keeps the file from growing forever, which is what the previous implementation
got wrong.

```sql
CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,   -- global, the SSE cursor
  run_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  type            TEXT NOT NULL,   -- message.delta | message.end | tool.execution.* |
                                   -- tool.approval.* | job.progress | conversation.title | run.*
  data            TEXT NOT NULL,   -- JSON
  created_at      INTEGER NOT NULL
);
CREATE INDEX events_run          ON events(run_id, seq);
CREATE INDEX events_conversation ON events(conversation_id, seq);
```

A global autoincrement cursor means a client can hold one watermark across a
whole conversation rather than one per run, which matters when an app resumes
after being suspended for an hour.

`tool.execution.start` payloads carry the `intent` string the model wrote as the
first argument, so clients get a live status label without a second model call.

### Approvals

```sql
-- Keyed by the tool call id, so a retried gate finds the existing decision
-- instead of asking twice.
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,          -- the tool call id, when it is trustworthy
  run_id          TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  action          TEXT NOT NULL,             -- delete | delete_recursive | overwrite |
                                             -- move | move_overwrite | shell
  summary         TEXT NOT NULL,             -- what the user is being asked, in their language
  detail          TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

The row, not the stream, is the decision: a client that was closed when the
question was asked finds it by listing pending approvals, a decision survives a
restart, and a run that died leaves rows that are expired at startup rather than
questions nobody can answer (`03-api.md §Approvals`).

The primary key is the provider's tool-call id, which is not the unique handle
it looks like — some OpenAI-compatible gateways omit the field, others restart
the numbering on every response. So a row is reused only when the incoming call
asks the *same question*: same conversation, tool, action, summary and detail.
Anything else opens a new row. Without that, a decision made about `npm test`
could be found and reused by a later call carrying the same id and a different
command, and the answer would have been given about something nobody read.

## Memory

A key is free text matching `^[A-Za-z0-9_-]{1,64}$`. Seven suggested names ship
as configuration and steer the first few writes; nothing rejects an eighth.

```sql
CREATE TABLE memories (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

`tokenLimit` (16 000) is enforced across all rows, `charLimit` (20 000) per
value, both at write time in the tool.

## Files, chunks, vectors

```sql
CREATE TABLE files (
  id               TEXT PRIMARY KEY,      -- "file_<32 hex>" or "img_<32 hex>"
  name             TEXT NOT NULL,
  mime             TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  disk_path        TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  conversation_id  TEXT,
  source           TEXT NOT NULL DEFAULT 'upload',  -- upload | generated | note | librechat
  embedding_status TEXT NOT NULL DEFAULT 'none',    -- none|pending|ready|failed
  embedding_error  TEXT,
  page_count       INTEGER,
  width            INTEGER,
  height           INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX files_created ON files(created_at DESC);
CREATE INDEX files_sha256  ON files(sha256);

CREATE TABLE chunks (
  id      TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  page    INTEGER,                        -- PDF page, NULL otherwise
  text    TEXT NOT NULL
);
CREATE INDEX chunks_file ON chunks(file_id, idx);

CREATE TABLE embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  file_id  TEXT NOT NULL,                 -- so re-embedding one file is one delete
  model    TEXT NOT NULL,                 -- "qwen/qwen3-embedding-8b"
  dim      INTEGER NOT NULL,              -- 4096 for that model; whatever the configured one returns
  vector   BLOB NOT NULL                  -- Float32Array, little-endian, L2-normalized
);
CREATE INDEX embeddings_file ON embeddings(file_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content = 'chunks',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);
```

`sha256` is more than a checksum, which is why it is indexed: a document whose
bytes are already in the library returns the row that holds them rather than
opening a second one. Two rows for one document are two copies of every chunk and
every vector, and retrieval then spends the agent's context on the same passage
twice — the fusion in `retrieval.ts` dedupes by chunk id and cannot see it,
because the duplicates are genuinely different chunks. Retrieval collapses hits
with identical text as well, since a library built before this was true still
holds the pairs.

Images are exempt. An image's id is also the handle for its `image_assets` row,
its metadata sidecar and its thumbnail cache, so collapsing two of them saves one
file and dangles three references.

**Why brute force.** Vectors are pre-normalized at write time, so similarity is
a plain dot product. The configured model is `qwen/qwen3-embedding-8b`, which
returns 4096 dimensions — 16 KB a row — and the live index is 9 documents in
4 666 chunks, or 73 MiB of vectors. Every search scores all of them: 19 M
multiply-adds, which is 19 ms in a typed loop over one `Float32Array` view. A
1.67 GB PostgreSQL runtime bought nothing.

The arithmetic was never the expensive part; the trip to it was. Reading each row
into its own `Float32Array` and then sorting the whole corpus to take ten hits off
the front cost 120 ms and some 19 000 allocations per search, repeated in full for
a corpus that had not changed between questions. So the matrix is packed once into
a single buffer and kept, keyed by a counter the store bumps on every write that
can touch a vector — the cascades from `chunks` and `files` included, since no
statement of ours mentions those. A warm search is 19 ms, the cold one that builds
the matrix is 112 ms, and no row costs an allocation.

The resident copy is capped by `LUMA_VECTOR_CACHE_BYTES`, 256 MiB, which is about
16 000 chunks at this width. Past the cap nothing is kept and the same kernel runs
over 8 MB pages read straight from SQLite — 407 ms for 20 000 chunks against
536 ms row-at-a-time, with memory flat instead of 313 MB. That is also about where
the real escape hatch starts to earn its keep: `sqlite-vec` against this same
table, still one file and still no second process.

Vectors are chunk-scoped, not file-scoped, so re-embedding one file never
touches another. `model` and `dim` are stored per row so a model change is
detectable and can be migrated incrementally instead of by a full re-embed.

## Image and video assets

Every generated image gets a provenance row, which is what makes "continue editing
this image" work across conversations and what the studio gallery lists.

```sql
CREATE TABLE image_assets (
  image_id         TEXT PRIMARY KEY,
  mime             TEXT NOT NULL DEFAULT 'image/png',
  width            INTEGER,
  height           INTEGER,
  provider         TEXT,                  -- "comfy" | "cometapi"
  model            TEXT,
  parent_image_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of source image ids
  created_at       INTEGER NOT NULL
);
```

`image_assets` records provenance, not identity: `files` is the one library, and
every image has a row there whatever produced it. The split exists because a tool
writes bytes to the asset directory before Luma is told about them, so the two
facts arrive at different moments — the file first, the provenance with the tool
result. Adoption reconciles them, and rows whose file is gone are pruned at
startup.

`source` is what makes the library navigable once it holds hundreds of images:
`upload` for something the user brought, `generated` for a tool's output, `note`
for a document written in the app, `librechat` for the migration. It is a plain
string rather than an enum so a future tool can name its own provenance without a
migration; clients label the ones they know and show the raw value otherwise.

`video_assets` is the same table two columns wider, because a video is asked the
same questions an image is, plus how long it is and what to show before it plays:

```sql
CREATE TABLE video_assets (
  video_id, mime, width, height,
  duration_ms, poster_image_id,       -- the two an image has no answer for
  provider, model, parent_image_ids,  -- the stills it was animated from, if any
  created_at
);
```

## Jobs and profiles

Generation is queued, so a request that takes minutes is a row rather than a held
connection, and a conversation's behaviour is a named bundle rather than a global.
Both are laid out and argued for in `08-generation.md`:

```sql
CREATE TABLE jobs (
  id, kind, op, model_id, model_name, conversation_id,   -- nullable: a studio job has no transcript
  status, progress, note,                                -- queued | running | succeeded | failed | cancelled
  params, sources, assets, error,
  provider_job_id,                                       -- present ⇒ resumable after a restart
  created_at, started_at, finished_at, updated_at
);

CREATE TABLE profiles (
  id, name, chat_model_id, image_model_id, edit_model_id, video_model_id,
  capabilities,                                          -- JSON: a subset selection, not a second config
  mcp_servers, global_prompt, tool_prompt, sort_order, created_at, updated_at
);
```

A job has no event log on purpose: its whole state is the row, so a reconnecting
client reads it instead of replaying deltas. That is the one place the runs
machinery is deliberately not reused.

## MCP servers

Definitions move out of `mcp.json` and into the database so they are editable
from any client.

```sql
CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,           -- "filesystem"
  title       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  command     TEXT NOT NULL,              -- '' for a remote server
  url         TEXT,                       -- set ⇒ HTTP transport instead of stdio
  args        TEXT NOT NULL DEFAULT '[]', -- JSON array
  env         TEXT NOT NULL DEFAULT '{}', -- JSON object; ${secret:name} refs resolved at spawn
  headers     TEXT,                       -- JSON object, sent on every remote request
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

One table holds both kinds of server, and which columns a row fills is what picks
its transport: a command is spawned over stdio, a URL is connected over
Streamable HTTP with the deprecated HTTP+SSE transport as the fallback
(`04-tools.md §Transports`). `headers` is not `env` under another name — one is a
child process's environment and the other is sent to a third party over the
network — so they are separate columns even though a row written before `url` and
`headers` existed still works by putting the URL in `command`.

`command`, `args` and `env` may reference `${AIGC_ROOT}`, `${PROJECT_ROOT}`,
`${NODE_EXE}` and one `${PROVIDER}_API_KEY` per configured provider, resolved from
the secrets table at spawn time (`04-tools.md §MCP`). Secrets are never stored
inline here.

## Capability configuration

Capabilities are one JSON document under `settings('capabilities')` rather than a
table, because they are read as a whole on every run and edited as a whole by one
screen. The shape is `Capabilities` in `src/shared/types.ts`: `memory`, `files`,
`web`, `coding`, `embedding`, `studio`. Defaults live in `src/server/config.ts`
and are merged over what is stored, so a capability gains a field without a
migration and without a null check at every use.

The same table holds `prompts`, `defaultModelId` and `defaultProfileId`.

## Maintenance

No scheduler, no daily job. Cleanup happens at the two moments when something
has just become garbage, which is when it is cheapest to know that it has:

- **At startup**, `pruneSettledTransientEvents(0)` deletes every replayable
  delta belonging to a settled run. Nothing can be mid-stream across a restart,
  so a client catching up is not a case that exists. Terminal events survive,
  and the transcript itself lives in `messages`.
- **When a run ends**, the same prune runs with `DELTA_RETENTION_MS`, which
  leaves recent deltas alone: a polling client reads in bursts, and deleting a
  run's deltas the instant it finishes erases text the client never received.

`PRAGMA incremental_vacuum` follows both, handing freed pages back to the
filesystem; `auto_vacuum = INCREMENTAL` is set at creation. At startup it is
deferred five seconds, because converting an older database rewrites the whole
file and that should happen behind a server already answering requests.

`scripts/tidy.ts` is the manual counterpart: it drops conversations, runs, events,
jobs and generated images and videos, and deletes the session database outright,
while keeping the source documents, memories, profiles and secrets. Use it to clear
out test artefacts after an end-to-end run, against a stopped server and with
`LUMA_DATA_DIR` pointed at the instance you mean — it defaults to the real one.

Incremental vacuum reuses free pages but never defragments, so a file that grew
during a bad import stays large. `scripts/reclaim-db.ts` is the tool for that one
job, and does it in the order that makes it safe on real data: verify integrity
first (vacuuming a corrupt file only writes the corruption back smaller), snapshot
with `VACUUM INTO` rather than copying a hot file, then compare row counts before
and after so "smaller" is never reported without "same contents". `--report` is
read-only and safe against a running server; `--apply` is the only mode that
writes.
