# Architecture

Luma is a single-user agent workspace. One Node process, no external services,
and its own data on disk. It replaces a LibreChat deployment that used four
processes, two databases and a `.env` file.

## Constraints that shape everything

1. **One process.** No Python, no PostgreSQL, no separate MCP supervisor. RAG,
   vector search and MCP clients all live inside the Node process. Two SQLite
   files, both embedded: `luma.sqlite` and the session trees in
   `sessions.sqlite` (`01-data-model.md`).
2. **No configuration files.** No `.env`, no YAML, no JSON config. Every setting
   and every secret lives in SQLite and is edited from a client.
3. **API-first.** The web UI is one client among several. An iOS/iPadOS app is
   planned, so no endpoint may assume a browser, a cookie, or a same-origin
   page. The web bundle is static and talks only to `/v1`.
4. **Capabilities are one document, not a schema per client.** Every capability's
   configuration is a field on one `Capabilities` object with server-side
   defaults, so adding a setting costs no migration and no client-side plumbing
   beyond the control that edits it. Where a form genuinely cannot be written in
   advance — a generation backend's parameters, an MCP server's tool — the schema
   comes from the server and the client renders it.
5. **Behavioural parity with LibreChat** on the paths that were actually used.
   See `03-tools.md` for the contracts and the places we deliberately diverge.

## Process layout

```
luma (node)                                   :8090
├── http            /v1 routes + static web bundle
├── agent           session tree, context assembly, compaction, pi loop, titles
├── capabilities    registry: web_search, file_search, memory, mcp, code, skills
├── generation      adapters (comfy, hosted images, async video) + job queue
├── rag             extract → chunk → embed → cosine + FTS5
├── mcp             clients over stdio, Streamable HTTP, legacy HTTP+SSE
└── store           node:sqlite

data/
├── luma.sqlite     everything persistent
├── sessions.sqlite conversation trees, owned by pi's session backend
├── master.key      32 random bytes, 0600, decrypts secrets in luma.sqlite
├── files/          uploaded and authored file bytes
├── skills/         <name>/SKILL.md, written procedures loaded on demand
├── workflows/      ComfyUI graphs in API format; a new one is a file, not a release
├── coding-trash/   what the code tools overwrote or deleted, plus a journal
└── assets/         generated images and videos, metadata sidecars, thumbnails

runtime/           bundled binaries, git-ignored, ~150 MB
├── node/           Node 24 — the only copy on this machine
└── cloudflared/    connector plus the tunnel config

run/               pid files and process logs, written by scripts/start.ps1|.sh
```

Nothing outside `data/` and `run/` is written at runtime. Deleting `data/` is a
factory reset.

`scripts/start.ps1` is the supported way to run it: rebuild the bundle, start
the server, raise the tunnel, print the access code. `scripts/restart.ps1` is
its development counterpart — foreground, no tunnel, and pointed at the audit
data directory rather than the real one, so a test run cannot write the
transcript it is meant to be testing next to.

### The same scripts on macOS and Linux

`start.sh`, `stop.sh`, `restart.sh` and `show-code.sh` are the POSIX
counterparts, same ports, same environment variables and same pid files, with
`--port` and `--local` where PowerShell takes `-Port` and `-Local`. Run them as
`bash scripts/start.sh`: a checkout on Windows carries no execute bit, so
depending on one would make the scripts un-runnable on the machine they were
written on.

Two things genuinely differ, rather than being translated. `runtime/node` is a
Windows build, so `scripts/common.sh` asks each candidate for its version instead
of merely testing that the file is there, and falls back to a system Node 24+
with an explicit error when neither can run. And stopping is two steps rather than
one: `Stop-Process -Force` is a kill with no shutdown, which is why the Windows
script has to sweep up MCP servers that outlived their parent, whereas the POSIX
version sends `SIGTERM`, waits ten seconds for the server to close its own stdio
children, and only then sends `SIGKILL`. ComfyUI has no POSIX launcher because
`comfy.ps1` drives the Windows Desktop installation under `%LOCALAPPDATA%`;
`start.sh` says so and carries on, since Luma runs without it.

ComfyUI is a separate process that Luma reaches over HTTP at `127.0.0.1:8188`,
and `scripts/comfy.ps1` starts it because an image tool that cannot reach it
fails at the point of use rather than at startup. From a cold file cache it can
take three minutes to index models and import custom nodes, so `start.ps1`
launches it alongside the build and waits only long enough to catch a process
that dies on startup — a bad install or a taken port fails within seconds, and
anything slower is just loading. Luma is fully usable meanwhile, minus the local
image tools. The program is the
ComfyUI Desktop installation under `%LOCALAPPDATA%`, while its models, inputs
and outputs are the workspace copies under `ComfyUI/shared` — the split that
`--base-directory` expresses. Custom nodes live in `ComfyUI/runtime/custom_nodes`
and are linked into both the install and the base directory, so the Desktop app
and the headless server see the same set.

`stop.ps1 -IncludeComfy` shuts ComfyUI down too. Plain `stop.ps1` deliberately
does not, because `start.ps1` calls it before every launch and reloading the
models costs a minute.

## Capabilities

A capability is a set of tools plus the configuration that decides whether they
are offered. All of it is one typed object — `Capabilities` in
`src/shared/types.ts` — read whole on `GET /v1/capabilities` and patched whole
back. Defaults live in `src/server/config.ts` and are merged over what is stored,
so a capability can gain a field without a migration and without a null check at
every use.

| Field | Offers | Configured with |
|---|---|---|
| `memory` | `set_memory`, `delete_memory` | suggested keys, token and char limits |
| `files` | `file_search` | search on/off, retrieval mode |
| `web` | `web_search` | which search adapter answers, and its key (write-only) |
| `coding` | ten `code` tools | workspace root, `read`/`write`/`shell` |
| `embedding` | the index behind `files` | base URL, model, dimensions, chunking |
| `studio` | the studio screen | which MCP servers it may drive |

Two of them are not on this list because they need no configuration: `skills` is
on when a skill exists on disk, and generation is on when a generation model is
configured. A capability that needs a key reports only whether one is set —
`hasTavilyKey`, `hasKey` — so a client can show "key missing" without the
plaintext ever leaving the server.

A profile selects a *subset* of what the deployment configured
(`07-generation.md §Profiles`): it can withhold a capability from one
conversation, never grant one the deployment has not set up.

### The `studio` capability

The studio is a capability rather than a hardcoded screen, so turning it off
removes it from every client. Its config is a list of MCP servers to expose, and
a server may be listed here while being disabled for chat — that combination
connects the process and routes its tools to the studio alone, which is how an
image backend can be available for deliberate work without enlarging the agent's
tool list on every turn.

Generation models join the same list. A model whose `kind` is `image` or `video`
is not a conversational endpoint, so it is excluded from the agent's model graph
and surfaced as a studio tool instead, described by the schema its adapter
declares — the same schema the agent's tool advertises. The studio therefore has
one kind of thing in it — a tool with a schema — whether the pixels come from a
local ComfyUI workflow or a remote API, and the local case is no longer an MCP
sidecar (`07-generation.md`).

## One file library

Everything the user owns is a `files` row: uploads, notes written in the app, and
images produced by any tool. This was not originally true — generated images
lived only in the asset directory — and the split meant the Files screen could not
show the majority of what existed. Tools still write bytes first and report
afterwards, so the reconciliation is explicit: a generated image is *adopted*
into `files` at the moment it is registered, and startup adopts anything an older
build left behind.

Filtering is server-side, by kind, provenance and filename. The library is
several hundred images; sending all of them so the browser can filter would undo
the thumbnailing that makes the screen usable in the first place.

### The `code` capability

Filesystem and shell access confined to one configured workspace, behind
independent read / write / shell switches that all start off. Ten tools; schemas
and the properties that hold across them are in `03-tools.md §5`. Two pieces of
it live outside the tools themselves, because they are policy rather than
mechanism: destructive calls are held at a preflight gate until a person answers
(`approvals`, `02-api.md`), and every overwrite or delete is copied into
`data/coding-trash` first so a wrong edit is recoverable rather than final.

### The `skills` capability

Written procedures the model can pull in on demand, from
`data/skills/<name>/SKILL.md`. It has no config and no switch: a conversation
gains it by there being a skill on disk. See `03-tools.md §6`.

## Multi-client design

The web app and the future iOS app are peers (`06-ios-app-prd.md` for what that
app is, `08-ios-implementation.md` for how it is built). Consequences that must
hold from the first commit, because retrofitting them is expensive:

**Device-scoped tokens.** The access code is exchanged once for a long-lived
device token. Each device gets its own row and can be revoked independently.
The web client keeps its token in an `HttpOnly` cookie set by the server; native
clients keep it in the Keychain and send `Authorization: Bearer`. Both transports
resolve to the same token record.

**Runs are server-side objects.** A run keeps executing when every client
disconnects. This already has to be true for browser refresh; it is what makes
the phone usable at all, since iOS suspends background connections aggressively.

**Two ways to read a run.** SSE for live streaming, and a polling endpoint that
returns the same events as a JSON batch. Native clients on flaky mobile networks
use the poll path when the app returns to the foreground and the stream has
died. Both are driven by the same `after=<seq>` cursor, so they interleave
safely.

**No base64 in payloads.** Images and files are always URLs. `GET
/v1/images/:id?w=` serves a cached WebP at the requested width, so a phone pulls
tens of kilobytes into a message list instead of a 4 MB PNG, and the immutable
cache headers mean scrolling back costs nothing.

**The client survives losing the connection.** A stream that dies mid-run is not
a failed run: the client reattaches on `visibilitychange` and `online` by
re-reading the transcript and resuming from its `after=<seq>` cursor, and it
never clears what is on screen unless the re-read succeeded. This is the
difference between an iPhone returning from the background to a live answer and
returning to a blank turn.

**Input is keyed to the pointer, not the screen width.** A touch keyboard has no
Shift, so on a coarse pointer Enter must stay a literal newline and sending
belongs to the button; stealing Enter there leaves no way to type a line break
at all. Hit targets grow to 44px and text fields to 16px under the same query,
the latter because iOS zooms the viewport into anything smaller on focus. Per-turn
actions, which hover reveals on a desktop, stay visible there for the same
reason. Width is the wrong signal for any of this — a narrow window on a laptop
still has a mouse.

**A client sees one version of a transcript.** Editing or regenerating a turn
moves the conversation's branch pointer back and re-projects the messages from
there, so every client reads the same single history and no client has to render a
tree. The abandoned turns stay in the session tree — that is free, and it is what
makes an accidental edit recoverable — but nothing in the API offers them, because
reconciling a visible fork on every client buys almost nothing. Sequence numbers
are reused after a rewind, so a client that rewinds refetches the transcript
instead of topping up from its cursor.

**Cursor pagination everywhere.** Conversation and message lists are paged. A
2000-message history must not be a single response.

**Bootstrap is one call.** `GET /v1/bootstrap` returns models, providers,
profiles, capabilities, prompts, MCP status, limits and the server version — every
answer needed to render settings and start a run. Conversations are deliberately
not in it, because that list is paged and changes far more often than settings do.

## Event durability

The previous implementation grew a 310 MB SQLite file, almost entirely `events`
rows, and the cause was not that deltas were written but that deleted rows are
never given back: SQLite hands a freed page to its freelist and leaves the file
the size it grew to.

So every event goes through one path — a row in `events`, broadcast to
subscribers — and the difference between an event that lasts and one that does not
is when it is deleted:

| Event | Kept | Purpose |
|---|---|---|
| `message.delta` | 120 s past the run settling | live typing, and the replay a polling client needs |
| `job.progress` | 120 s past the run settling | how far a generation got; the job row is the real answer |
| `message.end` | forever | the finalized message |
| `tool.execution.start` / `.end` | forever | tool cards, including the `intent` label |
| `run.*` | forever | lifecycle |

One durable path is what makes reconnecting the same operation whether the run is
live or long finished: the client asks for everything after its cursor and gets
it. Deltas outlive their run by two minutes because a suspended phone reads in
bursts, and deleting them the instant a run completes would erase text nobody had
received yet. After that they are pruned, and `PRAGMA incremental_vacuum` returns
the pages — which is the part the old implementation was missing.

## Secrets

`data/master.key` holds 32 random bytes generated on first start, mode 0600.
Secrets are stored in `luma.sqlite` as AES-256-GCM ciphertext with a per-record IV.
This mirrors LibreChat's `CREDS_KEY`/`CREDS_IV` scheme without asking anyone to
generate hex by hand.

Secret values are write-only over the API. A client can set one, see whether one
is set, and clear it. It can never read one back.

## Exposure

Luma is reachable from a phone on a mobile network, which means it is reachable
by everyone else too. The posture is defence in depth, because the single-user
assumption that makes the rest of the design simple also means one compromised
credential is total.

The outer layer is Cloudflare Tunnel with Access in front of it: the origin makes
an outbound connection only, so no port is forwarded and the machine has no
address to scan. Access authenticates before a request reaches Node. That layer
is deliberately not trusted on its own — a tunnel misconfiguration should degrade
to "still needs a password", not "wide open" — so the application authenticates
independently with an access code plus TOTP, and rate-limits failures per source
address with a much looser global cap so an attacker cannot lock the owner out by
failing on purpose.

That independence is currently load-bearing rather than theoretical: the Access
policy is not yet applied to the deployed hostname, so the access code and the
rate limiter are the live barrier. See `05-remote-access.md`.

Session cookies are `HttpOnly`, `Secure` and `SameSite=Strict`, and
state-changing requests validate their origin, which together close the
cross-site paths that a bearer-token-only design leaves open once cookies exist.
Sessions are listable and individually revocable, since the practical response to
a lost phone is revoking one device rather than rotating everything. Setup is in
`05-remote-access.md`.

## Verification

There is no unit-test suite. What a single-user deployment can actually be wrong
about is the wiring between real parts — a provider that rejects a field, a
stream that stops arriving, a job that never settles — and none of that is
reachable by mocking. So verification is two layers, both of which run against
running processes:

| Command | Needs | Proves |
|---|---|---|
| `npm run typecheck` | nothing | `src` and `scripts` compile, including the audit drivers |
| `npm run audit` | nothing external | no export without a caller, `01-data-model.md` still describing the real tables, schema/type agreement, prompt order, session and compaction behaviour, skills, generation adapters against local stubs, coding tools, approvals |
| `npm run e2e` | a running server | the HTTP contract end to end: streaming, files, retrieval, generation, jobs, profiles, approvals, pagination, search, and the error envelope |

`npm run e2e` talks to the audit instance — `audit-db.ts --clone` copies
configuration and provider keys into `data-audit/`, `restart.ps1` or `restart.sh`
serves it on 8095 with the access code `AUDITCODE` — so acceptance runs use the real models
and the real GPU against a throwaway transcript. A substring argument runs one
check (`npm run e2e -- job`).

The remaining `scripts/audit-*.ts` are single-purpose probes for when something
is already wrong: `audit-db.ts` reports on the live database, `audit-payload.ts`
captures the exact JSON a provider receives, `audit-bisect.ts` finds which field
a provider rejects, `audit-models.ts` runs one turn per configured model,
`audit-markdown.tsx` renders the transcript pipeline in Node.
`security-check.ts` is separate from the e2e run because it trips the login rate
limiter on purpose.

The browser layer is checked by hand. A driver that asserted on the previous
UI's class names was deleted with that UI rather than retargeted: what it
actually proved — nothing overflows at 390px, the transcript renders, an approval
card can be answered — depends on hooks the new UI has not been asked to promise
yet, and a suite pinned to utility classes would fail on every restyle without
catching anything.

## Alignment posture

Behavioural equivalence with LibreChat, not byte equality. Where LibreChat's
behaviour is worse for this deployment we diverge deliberately and record it:

| LibreChat | Luma | Why |
|---|---|---|
| `resendFiles` re-encodes every historical image each turn | Past images are named in the transcript; the model loads one with `view_image` | A long image conversation costs a fortune otherwise |
| Tool results hard-truncated at 12 000 chars | Bounded by pi's own dual limit — `DEFAULT_MAX_LINES` 2 000 or `DEFAULT_MAX_BYTES` 50 KB, whichever binds first, always cut on a line boundary — and the pruner still drops whole messages once the branch stops fitting | One character count either wastes context or cuts the compiler error in half, and it charged a Chinese result three times what it charged an English one of the same length |
| Memory writes can run on a background agent | Explicit tool calls only | `agent.enabled: false` was already the configured behaviour |

That bound has exactly two audiences, and the current turn is neither of them: it
is applied where a message is persisted and where the context for a call is
assembled (`src/server/agent/messages.ts`), so the model re-reads a bounded
result and the transcript stores a bounded one, while the client watching the
call happen still receives every byte the tool produced. The two limits are
separate constants that happen to be equal, because tightening the projected one
costs nothing — the next turn projects the stored result again — and tightening
the persisted one throws bytes away for good.

Everything else in `03-tools.md` is copied, including description strings.
