# Generation

Luma is a chat agent *and* an image workstation, and the second half was once
built twice. Hosted image APIs were rows in `models` with `api_mode =
'openai-images'`, reachable only from the studio and only able to draw from
nothing. Local ComfyUI was an MCP sidecar configured by environment variables on
an `mcp_servers` row, and it was the only path that could edit an existing image.
Video existed as the string `"video"` in a union type.

The consequences were visible from the outside. A hosted editor could not be
added at all, however many times it appeared in a provider's catalogue. Choosing
between local and cloud generation meant editing environment variables on an MCP
server. Sixty-three video model ids came back from CometAPI's catalogue and every
one of them was classified as a chat model, because there was nowhere else to put
them.

So generation is one interface with several adapters. ComfyUI is not special: it
is an image API that happens to listen on `127.0.0.1`. And because there is
exactly one interface, the tools the model calls are derived from it rather than
hand-written per backend.

## The interface

Four operations, named for what goes in and what comes out:

```
text_to_image   prompt                → image
image_to_image  prompt + 1..n images  → image      (this is "edit")
text_to_video   prompt                → video
image_to_video  prompt + 1 image      → video
```

An adapter declares what it can run, what parameters it takes, and then does the
work:

```ts
interface GenerationAdapter {
  /** Matches models.api_mode, so a row names its own adapter. */
  readonly id: string;
  /** What this backend implements; a model row narrows it and can never widen it. */
  readonly runs: readonly GenerationOp[];
  /** Parameters this model accepts for this op: one schema, two audiences. */
  schema(spec: ModelSpec, op: GenerationOp): JsonSchema;
  run(request: GenerationRequest, ctx: GenerationContext): Promise<GenerationResult>;
  /** Best effort, for backends that queue. */
  cancel?(providerJobId: string, ctx: { baseUrl: string; apiKey: string; store: Store }): Promise<void>;
}
```

The schema has two audiences and that is the point of putting it here: the studio
renders it as a form, and the agent tool advertises it to the model. They differ
in exactly two declared ways, both of them applied in `tools/generation.ts` so
neither is a surprise buried in the frontend. `intent`, the status label every
native tool takes (`04-tools.md`), is prepended to the tool's copy and stripped
before the job is submitted — a form has a caption of its own. And `forModel`
drops every parameter marked `audience: "studio"`. Any other one-sided parameter
is a bug in the adapter, not a feature, and the audit asserts as much.

The model is offered what follows from what the user asked for: the prompt, the
framing (`aspect_ratio`, `size`, `resolution`), a video's `duration`, and the ids
of the images it wants used. What it is not offered is the sampler and its
neighbours. A model cannot judge a step count or a CFG scale, does not know the
seed of the picture it is being asked to vary, and — handed exact pixels beside an
aspect ratio — can ask for 16:9 at 1024×1024 and mean neither. Whoever trained a
set of weights already chose those values and `AGENTS.md` asks that Luma follow
them; withholding the knob is how that recommendation stays in force instead of
being overruled once per call. Nothing is lost by omission, because an absent
parameter falls back to the adapter's declared default or to the value already in
the graph. The studio renders all of it, folded under 高级, which is where the
person who does have grounds — comparing checkpoints, pinning a seed — reaches it.

Settings that are neither a creative choice nor a manual one belong to neither
audience. A watermark, an output format, `n`, and a provider's own prompt-rewriting
or content switches are facts about a deployment, so they are set once: in the
adapter when the protocol fixes them, in the model row's `params.extra` when they
vary by model. They never appear in a schema at all.

`run` receives resolved source bytes rather than image ids, because "where do the
bytes come from" is Luma's problem, not the backend's, and every adapter would
otherwise reimplement the asset lookup. It reports progress through
`ctx.progress(fraction, note)` and honours `ctx.signal`. It returns saved assets,
not bytes:

```ts
interface ProducedAsset {
  assetId: string;
  kind: "image" | "video";
  mime: string;
  width: number | null;
  height: number | null;
  durationMs?: number | null;
  posterAssetId?: string | null;
}

interface GenerationResult {
  assets: ProducedAsset[];
  providerRequestId?: string;
  /** What the backend actually ran with, when it differs from what was asked. */
  effective?: Record<string, unknown>;
}
```

`ProducedAsset` is deliberately the least an adapter can report: only the backend
knows the id it just saved and the pixels it produced. The name, the provenance
and the timestamps belong to the rows the save already wrote, and asking every
adapter to carry them would be asking four backends to agree on bookkeeping none
of them owns.

So the queue expands each one on the way into the job row, reading those rows
back rather than trusting what was passed:

```ts
interface GeneratedAsset {
  id: string; assetId: string; kind: "image" | "video";
  mime: string; width: number | null; height: number | null;
  name: string | null; provider: string | null; model: string | null;
  parents: string[]; createdAt: number;
  durationMs: number | null; posterAssetId: string | null;
}
```

This is also, exactly, what `GET /v1/studio/gallery` returns — one shape, read
from the same `files` and asset rows, so a client renders a finished job with the
tile renderer it already has for the gallery and converts nothing. A job's whole
state is its row (§Jobs below), which means the row has to answer everything a
client would otherwise fetch: without this a client that had only seen the job
invented a filename and had no provenance until a reload. `assetId` stays
alongside `id` because the tools and the transcript refer to an asset by that
name.

The gallery once had a second, image-only shape of its own, and what that cost was
not a conversion but a place: a clip was in the library the whole time and the only
thing that ever showed it was the queue card that produced it, so a finished video
disappeared on the next reload.

## Models grow a kind

`models` keeps one row per callable thing. Three columns are added rather than a
second table, because provider, key, enablement, ordering and naming are already
solved there and a parallel table would fork all of it.

| Column | Meaning |
|---|---|
| `kind` | `chat` \| `image` \| `video` \| `embedding` \| `rerank` |
| `ops` | JSON array of the operations above; empty for `chat` |
| `params` | JSON, adapter-specific declaration (sizes, workflow bindings, durations) |

`api_mode` stays the wire protocol and gains the generation adapters:
`openai-images`, `venice-image`, `comfy-workflow`, `openai-videos`.
The registry already refuses to hand non-chat protocols to pi-ai; now it refuses
by `kind` instead of by a special case on one mode.

Fields that only make sense for a conversation — `context_window`, `max_tokens`,
`thinking_level`, `reasoning`, `temperature`, `top_p` — are ignored for
generation kinds and hidden by the editor. Asking someone to fill in a context
window for a drawing model is how the old form told them they were in the wrong
place.

### `comfy-workflow`, and why it needs no code per workflow

A ComfyUI model is a graph in API format plus a declaration of what that graph
exposes. Graphs live in `data/workflows/*.json`, so a new one is a file plus a
row rather than a release — and the declaration lives in the graph file, under a
top-level `luma` key, because which knobs a workflow has and what its author
recommends for them are properties of the workflow and not of `comfy.ts`. A model
row's `params` may declare the same things and wins the merge, since the row is
what a user can edit; `bind` and `controls` are merged key by key rather than
replaced, so overriding one binding does not silently drop the rest.

```json
{
  "luma": {
    "bind": {
      "prompt": "4.inputs.text",
      "width": "7.inputs.width", "height": "7.inputs.height",
      "seed": "8.inputs.seed", "steps": "8.inputs.steps", "cfg": "8.inputs.cfg",
      "sampler_name": "8.inputs.sampler_name", "scheduler": "8.inputs.scheduler",
      "denoise": "8.inputs.denoise"
    },
    "controls": {
      "steps": { "type": "integer", "title": "步数", "default": 8, "minimum": 1, "maximum": 30,
                 "description": "Turbo 权重按 8 步蒸馏，加步数只会更慢" },
      "cfg":   { "type": "number", "title": "CFG", "default": 1, "minimum": 1, "maximum": 8 },
      "sampler_name": { "type": "string", "title": "采样器", "default": "euler",
                        "enum": ["euler", "dpmpp_2m", "res_multistep", "lcm"] },
      "seed":  { "type": "integer", "title": "随机种子", "default": -1, "minimum": -1,
                 "description": "-1 每次随机" }
    },
    "sizes": { "auto": [1152, 1536], "1:1": [1344, 1344], "16:9": [1792, 1024] },
    "maxPixels": 1900000
  },
  "1": { "class_type": "UNETLoader", "inputs": { "…": "…" } }
}
```

**`bind`** maps a logical name to a `node.inputs.field` path in the graph. That
path-writing is the entire binding mechanism; nothing resolves node types or
guesses which sampler is the sampler.

**`controls`** gives each name a JSON Schema, keyed identically to its binding.
A knob is offered because the workflow declares both a binding and a control for
it — never because this adapter names it — which is what keeps `steps`, `cfg`,
`sampler_name`, `scheduler`, `denoise`, `seed` and `negative_prompt` available
with no model-specific code anywhere. The schema is the one an author writes for
their own weights: an 8-step Turbo checkpoint says `maximum: 30` and explains
that more steps only cost time, and that sentence reaches the studio form.

A declared control defaults to `audience: "studio"`, because everything a graph
declares about itself is by definition its author's tuning, and the list above is
the evidence: every one of those names is a sampler internal. A workflow with a
knob that is genuinely a creative choice — a style strength, a character weight —
says `"audience": "both"` and gets it back on the model's tool as well.

A control's `default` is used when the caller omits the value, and its
`minimum`/`maximum` are enforced on the way in — clamped, integers rounded,
booleans coerced — because a form posts strings and a node input is typed. An
unbound control is ignored: describing a knob the graph does not wire up would
offer the user a slider that changes nothing.

Seven names are **structural** and cannot be exposed as knobs even if a graph
binds them: `prompt`, `source`, `source_image_id`, `megapixels`, `width`,
`height` and `aspect_ratio`. They are written from the request itself, so a workflow
that redeclared them would be competing with the operation rather than
configuring it. `seed` is the one knob the adapter still touches: `-1`, the
convention every sampler UI uses, means a fresh seed per call, which is what
makes "draw it again" mean something, and naming a number is how a picture is
reproduced — from the studio, since a model has no way to know the number worth
naming.

The form is therefore `prompt`, plus `source_image_id` for the operations that
consume an image, plus `aspect_ratio` enumerating the keys of `sizes` for the ones
that do not, plus `width`/`height` when both are bound, plus every declared knob.
The tool is the first three: exact pixels and the declared knobs are the studio's. `sizes` names the shapes the weights were tuned for and
`maxPixels` (1 900 000 by default) refuses an explicit size above what the local
card will finish; `editMegapixels` is the same ceiling for an edit, which resizes
the source rather than refusing it.

Adding a workflow is therefore: drop the graph in `data/workflows/`, give it a
`luma` block, and point a model row at the filename. Only the file's basename is
used, because a model row is user input. The declaration is stripped from the
copy that is submitted — ComfyUI validates every top-level key as a node — and an
editor export is accepted alongside an API export, since that is what someone has
on disk after saving from ComfyUI itself. A missing or malformed declaration
degrades to "no knobs" rather than an error, because the schema is asked for on
every studio listing and every agent turn, and a bad file should not take a
screen down.

The graphs Luma ships are copied into `data/workflows/` on boot and kept current
after that, which installing them once was not: a graph revised in a new build
never reached an existing install, so a new parameter block only appeared for
whoever copied the files by hand. `data/` is still the user's, so a file is
replaced only while its bytes are the ones recorded in `meta.workflow_hashes` at
install time. Anything else is an edit — including a file predating the recording
and so unprovable either way — and an edit is kept and named on stdout rather
than silently overwritten.

The submit/poll/fetch mechanics are carried over from the sidecar this replaced,
including the parts that exist only because they were needed: `POST /prompt` with
a client-generated `prompt_id`, up to four attempts with the Desktop jobs API
answering "did my submit already land?" before each retry so a timed-out submit
cannot render twice, `GET /history/{id}` polled every second under a ten-minute
ceiling, `GET /view` for the output, and a cancel on the way out so a failed or
timed-out prompt does not keep the GPU.

### What "生成中" is actually doing

The queue distinguishes running from pending and nothing finer, so the stage and
the step count come from ComfyUI's WebSocket, which is the only place they exist.
`execution_start`, `executing` and `progress` are followed for our prompt id; the
executing node's `class_type` is matched against a small table to name what it is
doing (加载模型, 编码提示词, 采样, 解码放大, 保存), and an unrecognised class
reports itself rather than a guess, so a graph full of custom nodes stays legible
instead of reading 执行中 for four minutes.

The socket never decides whether the render finished — that is still read from
`/history`, so a backend that will not upgrade the connection loses the detail and
nothing else, and reports the queue position it always reported. Before any node
has executed, a prompt the queue calls running is the process warming up and the
weights coming off disk; on a cold start that is most of the wait, and it is
reported as 启动中，加载模型 rather than left blank.

A running prompt that has said nothing for 90 seconds has the length of its
silence appended to the note. From outside, a slow sampler and a wedged backend
look identical, and saying how long the silence has lasted lets the reader decide
to cancel instead of watching a bar that will never move again.

An edit workflow additionally binds `source` and, when present, `megapixels`; the
adapter uploads the bytes through `POST /upload/image` first and writes the
returned filename into the bound node. A graph that declares an edit operation
without a `source` binding fails as a configuration error, not as a bad render.

## Jobs

Local generation takes tens of seconds, a hosted edit a few seconds, and a video
minutes — long enough that the provider itself is asynchronous. One shape covers
all three so the studio and the agent do not diverge:

```
queued → running → succeeded | failed | cancelled
```

`jobs` rows carry `kind`, `op`, `model_id`, `model_name`, `params`, `sources`,
`status`, `progress` (0..1) with a human `note`, `provider_job_id`, `assets`,
`error`, the timestamps, and a nullable `conversation_id` — nullable because a
studio job belongs to nobody's transcript.

There is deliberately **no job event log**. A run needs one because its output is
a stream of deltas that a reconnecting client must replay; a job's entire state
is one row, so `GET /v1/jobs/:id` answers a reconnect completely and the SSE
stream is a convenience over the same row. This is the one place the runs
machinery is *not* reused, and the asymmetry is the reason.

A queue with per-backend concurrency runs them, because one local GPU cannot
serve two workflows and a hosted API can serve several. On restart, a job that
was `running` with a `provider_job_id` goes back to polling — a cloud video
outlives our process, and losing a paid minute of rendering to a redeploy would
be our fault, not the provider's. A `running` job with no provider id is failed,
the same reasoning as an orphaned operation in a session tree
(`05-agent.md §History`).

## 创作台

The manual side of the same adapters. Its whole form is generated from the schema
`GET /v1/studio/tools` sends, so a newly configured backend arrives with the right
controls and nothing here changes. What *is* decided here is the order the
questions get asked in.

**What you are doing comes before what does it.** Three tabs — 生成图片, 编辑图片,
视频 — and the model is a control inside the chosen tab. The single dropdown this
replaced listed every model crossed with every operation, so choosing to edit
meant reading past everything that could only draw. A tab with no model behind it
is not rendered, because a tab that only ever says "nothing configured" is
furniture.

**The model picker says what each backend can do**, read off the schema it already
sent: the aspect ratios, the resolutions, a video's durations, how many reference
images it takes. Local against hosted is the one thing the schema cannot say and
the thing most worth knowing before committing to a wait — slow and free, or quick
and billed — so `StudioTool.local` carries it, decided by whether the provider's
base URL is a loopback or private address.

**An edit starts from the picture.** The source slot sits above the prompt, since
the prompt only says what to do to it, and empty it is a drop target rather than a
button: what people have is a file on the desk or a tile in the gallery beside
them, and both of those are things you drag. A dropped file is uploaded and gets
an `img_` id and an asset row, which is what makes it editable at all
(`03-api.md`); a dragged gallery tile carries its own id and makes no second copy.
Every gallery tile also has an edit entry of its own, because editing used to be
two clicks and a modal away from the thing you wanted to edit.

**The wait is quoted from this queue's own record.** Before submitting, the median
of what this model took for this operation before, over the jobs on record. The
median and not the mean: a cold start that pulled twelve gigabytes off disk is in
there too, and one of those drags an average past anything the reader will see.
With no history there is no estimate, because a guess about a backend nobody has
run is not information.

**The queue is behind a badge in the header.** It used to hold the top half of the
canvas whether anything was running or not; now the space belongs to the results
and the badge says how many are in flight. It opens itself once on submit, so the
work is visibly somewhere, and stays closed after that if closed.

**A clip is a work, so it is in the grid.** The gallery lists both media, and it
had to: video was filtered out of it, and since the queue is where a job goes to
stop being shown, a finished clip was visible for as long as its card was and then
nowhere. There is no thumbnail to serve for one — no ffmpeg here to cut a frame,
and the poster a clip carries is only the still it was animated from, which a
text-to-video never had — so the tile is the video element at `preload="metadata"`,
which paints frame one and, because the route honours `Range`, pays for the head of
the file. It is badged with its duration either way: a first frame with nothing on
it is a photograph. The edit affordance is not offered on one, and neither is the
source picker, because nothing here takes a clip as input.

## What the model calls

Three tools by default, and their schemas come from the adapters:

| Tool | Op | Model it uses |
|---|---|---|
| `generate_image` | `text_to_image` | the conversation's image model |
| `edit_image` | `image_to_image` | the conversation's image model, or its edit model |
| `generate_video` | `text_to_video` or `image_to_video` | the conversation's video model |

A tool exists only when the conversation's profile names a model that supports
the op, which is what makes the tool list honest: no `edit_image` when the
configured backend cannot edit, instead of a tool that fails on first use.

Three, not one per configured model, because every tool's schema rides along in
every request: a catalogue of near-identical drawing tools is a standing token
cost and leaves the model choosing between equivalents. A deployment that wants
a particular backend reachable by name anyway sets `models.agent_tool`, and that
model gains `generate_image_<id>` / `edit_image_<id>` / `generate_video_<id>`
beside the three above. The flag is off on every row until someone sets it, and a
model already carrying one of the three is not offered a second time under its
own name. The extras are ordered by model id, so adding an unrelated model cannot
reshuffle the tool list and cost the provider's prompt cache.

`edit_image` requires `source_image_id` — an operation that consumes an image says
so in its schema rather than letting the adapter reject the call — and the ids of
images uploaded in the current turn are injected into its description, exactly as
the MCP version did: a model that cannot see the image still has to name it. On
`generate_video` the same field is optional, because naming a first frame is what
chooses `image_to_video` over `text_to_video`.

The tool call awaits its job and forwards progress as ordinary tool progress on
the run's event stream, so a client that can already render a run needs no new
code to watch an image appear. The result is an `image_ref` or `video_ref` part
in the transcript, and generated assets are registered exactly as before, so the
gallery, the file library and `view_image` keep working unchanged.

This replaced the image MCP sidecar, which is gone along with the `mcp_servers`
rows that configured it. MCP remains what it is for — third-party servers — and a
user who wants a sidecar of their own can still add one.

## Video assets

`vid_<32 hex>`, bytes under `data/assets/files/`, provenance in `video_assets`
(mime, width, height, `duration_ms`, `poster_image_id`, provider, model,
parents), and a `files` row so the library and the gallery see it without
learning a new table. Served by `GET /v1/videos/:id` with range support, because
a browser seeking in a video sends `Range` and a server that ignores it makes
scrubbing download the file again.

In a transcript a video is:

```json
{ "type": "video_ref", "video_id": "vid_<32 hex>", "mime_type": "video/mp4",
  "width": 1280, "height": 720, "duration_ms": 5000,
  "poster_image_id": "img_<32 hex>", "provider": "…", "model": "…" }
```

Never loadable into model context, and `view_image` will not open one: it
resolves an id only to a known image extension, so a `vid_…` id — which the
transcript names in plain text, making it the obvious thing for a model to try —
comes back as "no readable image" rather than as an mp4 base64'd whole and
posted as a picture. No provider we speak to accepts video frames as input, and
a poster image is what a follow-up question is actually about.

## Profiles

A conversation's behaviour was global: one capability blob, one set of enabled
MCP servers, one prompt pair. Choosing a model changed the LLM and nothing else.
A profile is the named bundle that was missing:

```
profiles(id, name, chat_model_id, image_model_id, edit_model_id, video_model_id,
         capabilities JSON, mcp_servers JSON, global_prompt, tool_prompt, …)
conversations.profile_id → profiles.id
```

`capabilities` in a profile is a subset selection over the deployment's
capability config, not a second copy of it: the profile says *whether* memory,
files, web, code and skills are offered, while their configuration — keys,
limits, workspace root — stays deployment-wide. Turning a capability on where the
deployment has not configured it does nothing, which is the same rule the global
switches already follow.

Empty prompt fields fall back to the global pair. A conversation with no
`profile_id` uses whichever profile has been made the default, so nothing has to
be migrated for the change to be inert on existing data.

Profiles are managed in settings and chosen per conversation from the chat
header. Until one is made the default the whole feature is inert: every
conversation resolves to the deployment's own configuration, which is exactly the
behaviour that existed before profiles. Nothing is promoted to default
implicitly — a profile withholds tools, so having the first "画图" preset ever
created quietly take the coding tools away from every conversation would be a
change nobody asked for.

## Discovery

`GET /providers/:id/models` asked one question — `GET {baseUrl}/models` — and
believed the answer. Two things follow from that and both were visible in
practice: Venice returns 112 chat models and no image models, because its image
catalogue is behind `?type=image`; and CometAPI's 63 video ids were suggested as
chat models because there was no other kind to suggest.

Discovery therefore gets per-provider probes: the OpenAI-shaped list, plus
Venice's typed lists, merged and de-duplicated. Classification returns a `kind`
and a suggested `ops` alongside the name, and the bulk-add form groups by kind so
adding eight image models is one gesture. A suggestion is a starting point, not a
verdict — the editor can always override it.

Where the provider states the kind, that answer wins; it knows. Where it does
not, the id is matched against family patterns — `veo|kling|sora|runway`,
`flux|sdxl|dall-e|imagen`, and so on. Those patterns will be wrong about
something the week after they are written, and that is the right trade here:
discovery renders a form, the user reads it before anything is saved, and a bad
guess costs one tap. This is a settings screen, not a conversation. Nothing the
agent decides mid-run works this way.

## The transport

A hosted image took 73 seconds when it worked and dropped its socket at 113
seconds when it did not — `fetch failed`, from a gateway that had answered the
same request minutes earlier. So the hosted adapters share one policy: a
transport failure is retried up to three times with backoff, and an HTTP answer
never is, because the backend has already spoken. A multipart body is rebuilt per
attempt, since a consumed `FormData` cannot be sent twice.

Two deliberate exceptions. A video **submit** is sent exactly once: a retry might
queue a second paid render, and the status poll is how a lost answer is recovered
instead. And a **poll** that goes unanswered is not a render that failed — the
backend is still working and we are the ones who lost the connection — so polling
tolerates five consecutive failures before giving up on work that may still be
in flight.

## What must be tested

- A workflow model generates an image with only a row and a graph file — no code
  path named after the workflow.
- An edit through a hosted adapter and an edit through ComfyUI produce the same
  shape of result and the same parent linkage.
- A job that is `running` with a provider id is still polled after a restart; one
  without a provider id is failed.
- A cancelled job cancels the ComfyUI prompt too, verified against the queue.
- `edit_image` is absent when the configured image model cannot edit.
- A generated video reaches the transcript as `video_ref`, is served with a
  working `Range` response, and never enters model context as frames.
- Two profiles in two conversations get different tool lists in the same server.
- Venice discovery returns image models; a video id is suggested as `kind: video`.
- A dropped connection on a hosted image is retried and still produces the image;
  a dropped connection on a video submit is not retried.

`scripts/audit-generation.ts` covers all of the above against local servers that
speak the ComfyUI, OpenAI-images and async-video protocols, so it needs neither a
GPU nor a bill. The live path is covered by `scripts/e2e.ts`: the image and edit
checks go through the agent, and separate checks submit a job to the real
backend, follow its stream to `succeeded`, fetch the asset, and prove a profile
both pins its chat model and withholds the tools it gates.
