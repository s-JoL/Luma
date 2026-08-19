# Luma for iPhone and iPad — product requirements

A native SwiftUI client for the Luma server described in `00-architecture.md`.
The server is unchanged infrastructure: one process on a home machine, reached
over Tailscale or a Cloudflare tunnel (`05-remote-access.md`). The app is a
second client alongside the web bundle and gets no privileged endpoint.

This document is written against the code as it exists, not against
`02-api.md` alone. Where the two disagree the real behaviour is documented here
and the divergence is called out, because an app built from the prose would not
compile against the server. Section 18 lists every endpoint the app needs, marks
which exist today, and orders the server work that has to land first.

It stops at *what* and *why*. `08-ios-implementation.md` is the build side — Xcode
settings, Swift types, per-screen measurements, and the order to write them in.

## 1. Scope

**In scope for v1.** Sign-in with access code and TOTP; the conversation list;
the chat transcript with streamed answers, tool activity and citations; the
composer with photo, camera and file attachments; model switching; stop, steer,
edit, regenerate and continue; the file library with search; the image studio;
memory; and enough of settings to add a provider, add and pin models, toggle
capabilities and manage MCP servers.

**In scope, read-mostly.** Coding. The agent's coding tools run on the server's
filesystem, so the phone is a place to watch a coding turn and approve
destructive steps, not a place to edit a repository. The app renders diffs and
tool output; it does not ship an editor.

**Out of scope for v1.** Multi-user accounts, sharing, push-to-server sync of
local documents, an offline model, a widget, a watch app, and Handoff. Each is
plausible later; none is load-bearing for the product, which is "reach my own
agent from my pocket".

**Non-goals.** The app does not reimplement safety filtering, prompt assembly,
tool routing or retrieval. Those live on the server and the app must not
duplicate them — a second implementation would drift and the two would disagree
about what the model saw.

## 2. Platforms and targets

| | |
|---|---|
| Minimum OS | iOS 17.0 / iPadOS 17.0 |
| Devices | iPhone SE (2nd gen) 375pt through iPhone Pro Max 440pt; every iPad |
| Idiom | One universal app, adaptive by size class, not by device |
| Framework | SwiftUI, with UIKit representables for the text view and the web-backed math renderer |
| Distribution | TestFlight, then App Store, single owner |

iOS 17 buys `Observable`, `ScrollView` position APIs, `ContentUnavailableView`,
and `onChange` with two-value closures. Supporting iOS 16 would cost a parallel
scroll-anchoring implementation for the streaming transcript, which is the
hardest part of the app.

## 3. Information architecture

Five destinations. On iPhone they are a tab bar; on iPad they are the sidebar of
a three-column `NavigationSplitView`.

```
Chat        conversation list → transcript          (the app's centre of gravity)
Library     files and documents → detail → preview
Studio      generate / edit images → gallery → detail
Memory      the agent's durable notes about the owner
Settings    providers → models → capabilities → MCP → prompts → security
```

Chat is the default destination on cold start and the app returns to it after
any modal. The other four exist because the web app has them and the data is
the same; they are not equally weighted, and Settings in particular is a
maintenance screen the owner visits rarely.

Conversation is the only nested navigation stack that can grow deeper than two
levels (transcript → message actions → file preview → image detail).

## 4. Navigation

**iPhone.** `TabView` with five tabs. Each tab owns a `NavigationStack`.
Selecting the already-selected tab pops that stack to its root; selecting it a
second time while at the root scrolls to top. The conversation list pushes the
transcript. The transcript is the only screen that hides the tab bar, because
the composer and the tab bar competing for the bottom safe area is the single
worst thing that can happen to a chat app's ergonomics.

**iPad.** `NavigationSplitView` with three columns: destination sidebar,
conversation list, transcript. In compact width (Slide Over, a narrow Split
View) the split view collapses to the iPhone layout automatically; the app must
not fight that.

**Deep links.** `luma://c/<conversationId>`, `luma://library/<fileId>`,
`luma://studio`. Universal links are deliberately not used: the server has no
public hostname in the default deployment, so an https link would not resolve.

**State restoration.** The app restores the last destination, the last open
conversation, and the transcript's scroll offset. It does not restore composer
text older than 24 hours, which is almost always stale intent.

## 5. Design tokens

Ported from `src/web/theme.css`, which is the source of truth, so the two clients
look like one product. The web tokens are `oklch` and semantic — `background`,
`card`, `muted-foreground` — and come in a dark and a light block; the hex below
is those values rasterised to sRGB. Dark is the primary appearance and the only
one v1 ships, but the names are the same in both, so adding light later is a
second token block rather than a second design.

```swift
enum Token {
  enum Color {                      // sRGB of the dark block in theme.css
    static let background   = #0F1014   // the page
    static let sidebar      = #090B0F   // the rail, one step below the page
    static let card         = #16181D   // cards, the composer, tool blocks
    static let popover      = #1B1D22   // sheets and menus
    static let muted        = #1F2226   // code blocks, inert fills
    static let secondary    = #222429   // secondary buttons
    static let accent       = #252B38   // hover and selection
    static let border       = #2B2E33
    static let input        = #35383E   // control outlines, one step stronger
    static let foreground   = #E5E8EC
    static let mutedFg      = #9499A0   // captions, metadata
    static let primary      = #7BA3F6   // the user's own bubble, primary buttons
    static let primaryFg    = #0F141D   // text on primary
    static let destructive  = #EA6972
    static let success      = #66CB79
    static let warning      = #EAB35F
    static let ring         = #6C90DC   // focus ring
  }
  // --radius is 0.625rem, with the sm/md/lg steps derived from it.
  enum Radius { static let normal = 10.0; static let small = 6.0; static let large = 14.0 }
  enum Space  { static let x1 = 4.0; static let x2 = 8.0; static let x3 = 12.0
                static let x4 = 16.0; static let x5 = 24.0; static let x6 = 32.0 }
}
```

**Type.** SF Pro via `.body`, `.callout`, `.footnote` and friends, never a fixed
point size, so Dynamic Type works without a parallel scale. Transcript body is
`.body` at the user's setting. Code and tool output are `.body.monospaced()`.
The web app's 14.5px / 1.65 line height maps to `.body` with
`.lineSpacing(Token.Space.x1)`.

**Elevation.** Three surfaces and no more: `background` for the page, `card` for
cards, the composer and tool blocks, `popover` for sheets and menus. Separation
comes from `border`; shadows are reserved for what actually floats above the
page, which on iOS is the system's job anyway.

**Motion.** `.snappy` for state changes, `.smooth` for scroll-following. Every
animation respects `accessibilityReduceMotion`, which in practice means the
streaming caret stops pulsing and the tool-block disclosure snaps.

## 6. Screens

### 6.1 Sign in

A single centred card: access code field, optional TOTP field, "Server" row
showing the configured base URL with an edit affordance, and a primary button.

The app calls `GET /v1/auth/challenge` when the screen appears and again when
the base URL changes. `totpRequired: true` shows the TOTP field up front instead
of surprising the user with a rejected attempt. `lockedFor > 0` disables the
button and shows a live countdown, because the server will answer `429` anyway
and letting the user hammer a locked endpoint is worse than telling them.

States: idle; validating; `401 unauthorized` (inline error under the code
field, field keeps focus and content); `401 totp_required` (reveal the TOTP
field, not an error); `401 bad_totp`; `429 too_many_attempts` (countdown);
network unreachable (offer to edit the server URL, since a wrong host is the
most likely cause on first run).

The token from `POST /v1/auth/token` goes to the Keychain with
`kSecAttrAccessibleAfterFirstUnlock` — the app must be able to refresh a
conversation from a background push before the device is unlocked. Native
clients use `Authorization: Bearer`; the cookie path is web-only.

### 6.2 Conversation list

Rows show title, relative timestamp and message count, from
`GET /v1/conversations`. Search filters titles locally over the loaded page and
falls back to a server query when the list is longer than one page.

Swipe left: Delete (destructive, confirmed). Swipe right: Archive. Long press:
a context menu with Rename, Change model, Duplicate title to clipboard, Delete.

Empty state uses `ContentUnavailableView` with a "New conversation" action.
An untitled conversation shows "New conversation" until the server's title event
arrives, at which point the row animates its text — the title is generated
asynchronously and arrives on the run's event stream as `conversation.title`.

### 6.3 Transcript

The centre of the app. A scroll view of turns, a stop/steer bar while running,
and the composer pinned to the keyboard.

**Turn kinds.** User turn (right-aligned bubble, attachments as a thumbnail
row); assistant turn (full-width prose, no bubble — a bubble wastes 15% of a
phone's width on the content people actually read); tool block; error block.

**Assistant rendering** must match the web renderer exactly, because the same
answer will be read on both. That means GitHub-flavoured Markdown, fenced code
with syntax highlighting and a copy button, tables that scroll horizontally
rather than squeezing, inline and display math, images by `imageId`, and
citation links.

Three rendering rules are not obvious and each one exists because it was
observed breaking:

1. **Private-use citation markers must never be visible.** The model emits
   `\ue200…\ue201` around a citation group and `\ue202` before each anchor. The
   app strips every code point in `U+E200…U+E204` after resolving anchors to
   links. A naked `` in a bubble is the most visible possible rendering bug.
2. **Consecutive links need separation.** `[a](…)[b](…)` with no separator
   renders as one run-on word. Insert a thin space between adjacent link nodes.
3. **Unterminated syntax must not flicker.** During streaming, `**bold` arrives
   before its closing `**`. Rendering each prefix verbatim makes the last line
   flash between literal asterisks and bold text on every token. Mask the
   incomplete tail — an odd count of an inline delimiter, a partial fence
   opener, an unclosed link — until it closes. `src/web/markdown.tsx` has the
   reference implementation and `scripts/audit-markdown.tsx` the reference test:
   every prefix of a streamed line is rendered and none may show a delimiter
   that has not closed yet.

**Tool blocks** are collapsed by default and show the model's `intent` sentence
as the status line — the first argument of every tool call is a sentence the
model wrote about what it is doing, and it is better than any status string the
app could invent. Expanded, a block shows arguments and result, pretty-printed,
with a copy button. Running blocks show an indeterminate progress line; finished
ones show a duration; failed ones show the error in `danger`.

**Approval cards** appear inline where the tool block will go, keyed by tool call
id, whenever the server holds a destructive call (see §Approvals in `02-api.md`).
Not a sheet or an alert: the reader needs the tool calls above the card to judge
what the model is doing, and a modal that covers them turns the decision into a
guess. The card carries the action badge, the server's one-sentence summary, the
detail rows it supplies (paths, file counts, byte totals), and whether the action
is recoverable. Approve and Reject are the same size and weight — a reject that
is harder to hit than an approve is not a safety control. On tap the app POSTs and
then waits for `tool.approval.resolved` to repaint, rather than assuming its own
optimistic state, so two devices watching the same run agree.

Three states the app must handle and cannot fake: the card is answerable only
while `status` is `pending`; a settled card shows the outcome and no buttons; and
a card the app finds already `expired` on open means the fifteen-minute deadline
passed unanswered, which is a refusal, not a failure to load. The pending list
must be fetched on every transcript open and on every return to the foreground —
a run held on a question emits no further events, so a client that waits for the
stream to tell it will wait forever.

**Scroll behaviour.** Follow the tail while the user is within 80pt of the
bottom; the moment they scroll up, stop following and show a "Jump to latest"
pill. Anchor by turn identity, not by content height, so a code block finishing
its highlight pass does not yank the viewport.

**Message actions** (long press, or a trailing menu on iPad): Copy, Copy as
Markdown, Select text, Edit (user turns), Regenerate (assistant turns), Delete
from here. Edit and Regenerate both post a run with `fromSeq`; see 12.3.

### 6.4 Composer

Growing text view, 1 to 8 lines, then internal scroll. Left: attachment button
(photo library, camera, files) and the model chip. Right: send, which becomes
stop while a run is active.

Attachments upload immediately on selection to `POST /v1/files` with
`conversationId`, showing per-item progress, and the returned file ids go into
the run's `attachments` array. Uploading on selection rather than on send means
the send tap is instant even with three photos attached, and a failed upload is
reported while the user is still looking at the picker rather than after they
have committed to a message.

Limits come from `bootstrap.limits` (`maxUploadBytes`, `maxAttachmentsPerMessage`)
and are enforced client-side with a clear message, not silently.

The model chip opens a menu of pinned models. Non-pinned models are reachable
through "All models…" — an aggregator exposes hundreds and a person uses four.

### 6.5 Library

`GET /v1/files` with `kind`, `source`, `q`, and offset paging. A segmented
control for kind (All / Documents / Images) and chips for source, each chip
carrying the count from `facets` — a count computed with the *other* filters
applied, so the number on a chip is what tapping it will show.

Images render as a grid of thumbnails via `GET /v1/images/:id?w=320`. Documents
render as rows with an embedding-status badge: indexed, pending, or failed with
the error. A failed embedding offers Reindex.

Detail: preview, metadata, "Ask about this file" (opens a new conversation with
the file attached), Reindex, Delete. Text and note files are editable in place
through `PUT /v1/files/:id/text`; PDFs and images are not, which is why the
edit affordance is absent rather than disabled for them.

### 6.6 Studio

Tool picker (from `GET /v1/studio/tools`), a form generated from each tool's
JSON Schema, and a gallery. The form is generated, not hand-written, so a new
backend appears in the app without an app update — the whole reason the studio is
schema-driven. An entry may be a generation model (one per operation: draw, edit,
video) or a third-party MCP tool; the app treats them identically because the
server describes them identically.

Schema-to-control mapping: `enum` → menu; `boolean` → toggle; `integer`/`number`
with `minimum` and `maximum` → slider with a numeric field; `string` with
`maxLength > 120` → multi-line; everything else → single-line. `default` is
prefilled and `description` becomes the footer.

A run is `POST /v1/studio/run`, which is synchronous and can take a minute on a
local diffusion model. The app shows a determinate-looking progress affordance
with elapsed time, keeps the request alive in a background task, and never
blocks the rest of the UI. A video is minutes rather than seconds, so for those the
app should submit `POST /v1/jobs` and follow `GET /v1/jobs/:id/events` instead —
the same row answers a poll after iOS suspends the stream. A result carries
`videoId` where an image carries `imageId`, and playback comes from
`GET /v1/videos/:id`, which honours `Range` so scrubbing does not refetch.

### 6.7 Memory

A list of `key: value` rows from `GET /v1/memory`, a token budget meter, and
edit and delete per row. The key field is free text validated against
`^[A-Za-z0-9_-]{1,64}$`, with `suggestedKeys` from the snapshot offered as
completions. Over-budget writes fail with `400 over_budget` and the app shows
what would have to be freed.

### 6.8 Settings

Providers (name, base URL, key state — write-only, never read back), Models
(add, bulk add from the provider's live catalogue grouped by kind, edit — including
a generation model's kind, operations and adapter parameters — pin, set default),
Profiles (the per-conversation bundle of models, capabilities, MCP servers and
prompts, one of them the default),
Capabilities (memory, files, web, coding, embedding, studio, each rendered from
its own shape), MCP servers (command, args, env, enabled, connection status and
tool list), Prompts (global, tool, title model), and Security (change access
code, enrol or remove TOTP, list and revoke sessions).

Two rules the web app already follows and the phone must not break: a key is
write-only (the field shows "configured" or "not configured", never the value),
and enabling a capability that lacks its secret shows the missing field inline
rather than failing at generation time with `422 not_configured`.

## 7. Adaptive layout

| Width | Layout |
|---|---|
| < 500pt (all iPhones portrait, Slide Over) | Single column, tab bar, transcript full-bleed, composer pinned to keyboard |
| 500–759pt (iPhone landscape, narrow Split View) | Single column; transcript content capped at 680pt and centred |
| 760–1023pt (iPad portrait, half Split View) | Two columns: list + transcript; destination sidebar in a toolbar menu |
| ≥ 1024pt (iPad landscape, full screen) | Three columns: sidebar + list + transcript |

Transcript prose is capped at 680pt regardless of window width. A 1366pt line of
Chinese text is unreadable and the web app already caps it; the two clients
should break lines in the same places.

The three phone widths that matter are 375, 390 and 430pt. At 375pt the
composer's attachment button, model chip and send button must still each meet
44×44pt with 8pt between them; if they cannot, the model chip loses its label
and keeps only its icon. This is the tightest constraint in the app and every
composer change is checked against it.

## 8. Component states

Every interactive component defines six states and none may be skipped:

| State | Rule |
|---|---|
| Idle | Default. |
| Loading | Skeleton for first load of a list; inline spinner for a refresh. Never a full-screen spinner over content that already exists. |
| Empty | `ContentUnavailableView` with the one action that resolves it. |
| Error | Inline, with the server's `error.message` verbatim and a Retry. Never "Something went wrong". |
| Offline | A banner, not a modal. Cached content stays readable and mutating controls disable. |
| Disabled | Explains itself on tap: "Web search needs a Tavily key" opens the relevant setting. |

Error text comes from the server envelope
(`{ error: { code, message, field } }`). `message` is written to be shown to a
person; the app displays it rather than mapping `code` to its own string, so a
new server-side failure mode is legible on an app build that predates it.

## 9. Gestures

| Gesture | Effect |
|---|---|
| Swipe from left edge | Back / reveal conversation list |
| Swipe left on a list row | Delete (destructive, confirmed) |
| Swipe right on a list row | Archive |
| Long press on a turn | Message actions menu |
| Pull down on the transcript | Refetch from the last known seq |
| Pull down on the conversation list | Refresh |
| Two-finger pan on a turn | System text selection |
| Pinch on an image | Zoom to a full-screen viewer with dismiss-by-drag |
| Long press on a tool block | Copy raw JSON |

No custom gesture may shadow a system one. In particular the transcript must not
attach a horizontal drag, because that is the back gesture.

## 10. Accessibility

VoiceOver labels every control; icon-only buttons carry an
`accessibilityLabel`. A turn is one VoiceOver element reading
"Assistant, <text>", not one element per Markdown node, with a rotor entry for
code blocks. A running turn announces "Generating" via
`.accessibilityAddTraits(.updatesFrequently)` and posts a polite announcement on
completion — not on every token, which would make the device unusable.

Dynamic Type is supported to AX5. At AX3 and above, the composer's row of
controls wraps above the text field instead of shrinking, and tool blocks stop
showing their inline duration.

Contrast: `text` on `bg` is 14.8:1, `textDim` on `bg` is 7.4:1, and `accent` on
`bg` is 7.1:1, all clearing WCAG AA. `textFaint` (3.9:1) is used only for
decorative timestamps at `.footnote` or larger, never for anything a person has
to read to operate the app.

Reduce Motion stops the caret pulse and disables the tool disclosure animation.
Reduce Transparency replaces the composer's material with solid `bgRaised`.
Full Keyboard Access reaches every control in visual order.

## 11. Hardware keyboard and multitasking

| Shortcut | Action |
|---|---|
| ⌘N | New conversation |
| ⌘K | Search conversations |
| ⌘↩ | Send |
| ⇧↩ | Newline |
| ⌘. | Stop the run |
| ⌘⌥→ / ⌘⌥← | Next / previous conversation |
| ⌘1…⌘5 | Switch destination |
| ⌘F | Find in transcript |
| Esc | Dismiss sheet, or unfocus the composer |

The app supports Split View, Slide Over and Stage Manager at every size. Two
scenes of the same app may show two different conversations; each scene owns its
own navigation state, and both observe the same store, so a title generated in
one scene updates the list in the other.

External keyboard focus follows the platform: the composer takes focus when a
conversation opens, and ⇥ moves through the composer's controls before leaving
for the transcript.

## 12. Streaming

### 12.1 The real event contract

`02-api.md` documents event names that the server does not emit. These are the
names on the wire, from `src/server/agent/runtime.ts`:

| Type | Persisted | Payload |
|---|---|---|
| `run.started` | yes | `{ modelId, model }` |
| `message.delta` | transient | `{ assistantMessageEvent, modelCallIndex }` — written, then pruned after the run settles |
| `tool.execution.start` | yes | `{ toolCallId, toolName, args, modelCallIndex, toolCallIndex }` |
| `tool.execution.end` | yes | `{ toolCallId, result, isError, … }` |
| `message.end` | yes | the finalized message |
| `conversation.title` | yes | `{ title }` |
| `run.completed` / `run.failed` / `run.cancelled` | yes | `{ message? }` |

Three differences from the prose matter to a client author. The tool events are
`tool.execution.start` / `tool.execution.end`, not `tool.start` / `tool.end`.
`message.delta` carries a nested `assistantMessageEvent`, not `{ messageId, text }`.
And deltas *are* persisted, briefly: the server writes them, then prunes settled
ones on a retention window and reclaims the pages. A client must therefore
tolerate replayed deltas for a recently finished run and deduplicate by `seq`.

### 12.2 Client state machine

```
        ┌──────── idle ────────┐
        │                      │
  POST /runs 202          open transcript
        ↓                      │
    starting ──── run.started ─┴──→ streaming
        │                              │  message.delta      → append
        │                              │  tool.execution.*   → upsert by toolCallId
        │                              │  message.end        → settle the turn
        │                              ↓
        │                       ┌── terminal ──┐
        │                       │              │
   error/timeout          run.completed   run.failed / run.cancelled
        ↓                       ↓              ↓
    reconnect  ←──── stream closed, run still active
        │
   (backoff 0.5s, 1s, 2s, 4s, 8s, capped; resume from last seq)
```

Every transition is keyed on `seq`. The client keeps `lastSeq` per run, always
reconnects with `?after=<lastSeq>`, and drops any event whose `seq` it has
already applied. This is what makes replay safe and what makes the poll and SSE
paths interchangeable.

`POST /v1/conversations/:id/runs` returns `{ runId, seq }` where `seq` is the
watermark *before* the run produced anything, so the client can start streaming
without racing the first event. The client must use that value and not 0, or it
will replay the entire event table.

### 12.3 Edit, regenerate, continue

`fromSeq` on a run deletes that message and everything after it, then starts.
Editing sends new text at the old message's seq; regenerating sends the original
text back. There is no branch: the transcript is the agent's only memory, and a
hidden second history would drift from what the reader sees.

Because a rewind reuses sequence numbers, **a client that sends `fromSeq` must
refetch the transcript from `after=-1` rather than topping up.** Topping up
after a rewind is how a client ends up showing two versions of the same turn.

`POST /conversations/:id/continue` resumes a stopped answer. If the transcript
ends on an assistant message the server appends a short continuation
instruction as an ordinary user message, visible like anything else; only a run
that died between a tool result and the next model call resumes silently.

### 12.4 Background, interruption, offline

iOS suspends the app a few seconds after backgrounding and kills the SSE
connection. The behaviour is:

1. On `scenePhase == .background`, start a `UIApplication` background task,
   switch from SSE to `?mode=poll` (which long-polls for up to 25 s), and use
   the remaining background time for at most one poll cycle.
2. When background time expires, record `lastSeq` and stop cleanly. The run
   keeps going on the server; nothing is lost.
3. On `.active`, reconnect with `?after=<lastSeq>`. If the run has finished, the
   reconnect yields only persisted events and the transcript completes without
   the token animation — the correct trade for not writing a 310 MB database.
4. If the network is down, show the offline banner, keep the transcript
   readable, disable send, and retry on `NWPathMonitor` reporting satisfied.

A run that is active when the app is killed is picked up on next launch:
`GET /v1/runs/:id` reports its status, and a still-running run is re-followed
from the transcript's last seq.

**Timeouts.** No request times out during streaming — the heartbeat comment
every 15 s is what proves liveness. If 45 s pass with no frame and no heartbeat,
treat the connection as dead and reconnect. A tool call may legitimately take
ten minutes (`CALL_TIMEOUT_MS` is 600 s on the server) and the client must not
give up on it.

**Parallel taps.** Send is disabled the instant it is tapped and stays disabled
until the POST resolves. Every run POST carries an `Idempotency-Key`, so a retry
after a dropped response returns the original run instead of starting a second.
The server also rejects a concurrent run with `409 run_active`, which the app
treats as "already running" rather than as an error to show.

## 13. Notifications

Local only. There is no APNs infrastructure and adding one would mean the home
server holding push credentials and reaching Apple, which is a real operational
cost for a single user.

When a run is still active as the app backgrounds, schedule a local notification
for the run's completion, delivered by the background poll while it lasts.
Long-running work started deliberately — a studio generation, a coding turn —
also schedules one. Tapping opens the conversation deep link.

If the background task expires before the run finishes, the app has no way to
know when it completed and schedules nothing. That is an accepted limitation of
not running a push service, and the app should not fake it with a guessed timer.

## 14. Security

The token lives in the Keychain, never in `UserDefaults`. Native requests use
the `Authorization` header; the cookie path exists for the browser and the app
must not rely on it.

The base URL is user-configurable and stored per install. Plain HTTP is allowed
only for RFC 1918 and Tailscale (`100.64.0.0/10`) addresses via a scoped ATS
exception; anything else must be HTTPS. This is what makes `http://192.168.1.20:8090`
work without opening the whole app to cleartext.

Face ID or Touch ID optionally gates app launch and always gates revealing a
TOTP secret. Sensitive screens set `.privacySensitive()` so the app switcher
snapshot is redacted.

The app does not log request bodies, tokens or model output in release builds.
Crash reports carry no conversation content.

No content filtering is implemented in the app. Safety is handled by dedicated
upstream and downstream components and duplicating it in a client would produce
a second, divergent policy.

## 15. Performance targets

| Metric | Target | Measured how |
|---|---|---|
| Cold launch to interactive | < 900 ms | `os_signpost` from `didFinishLaunching` to first frame |
| Bootstrap round trip on LAN | < 150 ms | server `GET /v1/bootstrap` |
| Transcript open, 100 messages | < 250 ms to first paint | signpost around the fetch and render |
| Transcript fetch, longest real conversation | < 2000 ms | measured today at 14 messages / 10 KB / 11 ms |
| Streaming frame rate | 60 fps sustained | Instruments, Animation Hitches |
| Token-to-paint latency | < 50 ms | signpost from SSE frame to committed render |
| Memory, 500-message transcript | < 220 MB | Instruments, Allocations |
| Scroll hitch rate | < 5 ms/s | Xcode Organizer |

The streaming targets are the hard ones. They require that a delta re-renders
only the last turn — not the transcript — and that Markdown parsing is
incremental and off the main actor. The web client had to learn both lessons:
recomputing citations on every delta and re-parsing the whole answer per token
were the two measured causes of jank there, and a naive SwiftUI port will
reproduce them exactly.

## 16. Analytics and diagnostics

No third-party analytics. A diagnostics screen shows the server version, the
round-trip time of the last bootstrap, the connection mode (SSE or poll), the
current `lastSeq`, and a share sheet for the last 200 lines of a redacted
client log. This is a single-user app; a support flow is the owner reading their
own log.

## 17. Acceptance criteria

The app ships when all of these pass on an iPhone 15 Pro and an iPad Pro 11".

**Auth.** Wrong code shows the server's message and preserves input. TOTP is
requested up front when enrolled. Lockout shows a live countdown. The token
survives a device restart and a background launch before first unlock fails
closed rather than crashing.

**Chat.** A 200-message conversation opens in under 250 ms to first paint.
Streaming holds 60 fps with a code block, a table and display math on screen.
Stopping a run leaves a partial answer and Continue resumes it. Editing a
message mid-transcript truncates and re-runs, and the client refetches from
`after=-1`. Ten rapid taps on Send produce exactly one run.

**Rendering.** The reference string renders with bold "五图卡点", both links
tappable and visually separated, and no visible private-use character:

```
**五图卡点：**开门入冬 → 清点存货 → 蒸汽里听见脚步 间躺平、基建种田。[youtube.com](…)[bilibili.com](…)
```

Replaying any answer one character at a time never shows a raw `**`, `` ` ``,
`~~` or `$`, and never shifts layout by more than 0.05 CLS-equivalent.

**Streaming resilience.** Backgrounding for 30 s and returning resumes with no
duplicated and no missing content. Airplane mode mid-run shows the offline
banner and recovers on reconnect. Force-quitting mid-run and relaunching
re-attaches to the still-running run.

**Files and images.** A 20 MB PDF uploads with progress and reports its
embedding status. A 300-image library scrolls at 60 fps on thumbnails. An image
opens, zooms and dismisses by drag.

**Tools and coding.** A tool call shows its intent sentence while running and
its result when expanded. A destructive coding step stops and asks: the
transcript shows a card naming the file and its size, the step does not run
until the reader taps Approve, tapping Reject leaves the file untouched and the
model says so, and backgrounding the app mid-question and returning still shows
the card. The deletion is recoverable afterwards.

**Accessibility.** VoiceOver reads a full transcript in order. AX5 Dynamic Type
leaves no clipped or overlapping text on a 375pt screen. Full Keyboard Access
reaches every control.

**Adaptive.** No horizontal overflow at 375, 390, 430, 744, 834 and 1024pt, in
both orientations, in Slide Over, and in Stage Manager at an arbitrary window
size.

## 18. API surface: what exists, what is missing

### 18.1 Exists and is sufficient

Verified against `src/server/http/`:

```
GET    /v1/health                              GET    /v1/auth/challenge
POST   /v1/auth/token                          POST   /v1/auth/logout
GET    /v1/bootstrap

GET    /v1/conversations                       POST   /v1/conversations
GET    /v1/conversations/:id                   PATCH  /v1/conversations/:id
DELETE /v1/conversations/:id                   GET    /v1/conversations/:id/messages
GET    /v1/conversations/search?q=
POST   /v1/conversations/:id/runs              POST   /v1/conversations/:id/continue
POST   /v1/conversations/:id/stop              POST   /v1/conversations/:id/steer
GET    /v1/runs/:id                            GET    /v1/runs/:id/events[?mode=poll]
GET    /v1/conversations/:id/approvals         GET    /v1/approvals
POST   /v1/approvals/:id

GET    /v1/providers        POST/PATCH/DELETE  PUT/DELETE /v1/providers/:id/key
GET    /v1/providers/:id/models
GET    /v1/models           POST/PATCH/DELETE  POST /v1/models/bulk   PUT /v1/models/default
GET    /v1/profiles         POST/PATCH/DELETE  PUT  /v1/profiles/default
GET    /v1/capabilities     PATCH              PUT/DELETE /v1/capabilities/secrets/:name
GET    /v1/mcp/servers      POST/PATCH/DELETE  POST /v1/mcp/reconnect
GET    /v1/prompts          PUT

GET    /v1/files            POST               POST /v1/files/notes
GET    /v1/files/:id        DELETE             GET/PUT /v1/files/:id/text
GET    /v1/files/:id/content                   POST /v1/files/:id/reindex
POST   /v1/files/search                        GET  /v1/images/:imageId[?w=]
GET    /v1/videos/:videoId  (Range)

GET    /v1/studio/tools     GET /v1/studio/gallery     POST /v1/studio/run
GET    /v1/jobs             POST /v1/jobs              GET  /v1/jobs/:id
POST   /v1/jobs/:id/cancel  GET  /v1/jobs/:id/events
GET    /v1/memory           PUT /v1/memory/:key        DELETE /v1/memory/:key

GET    /v1/security         PUT  /v1/security/access-code
POST   /v1/security/totp    POST /v1/security/totp/confirm   DELETE /v1/security/totp
DELETE /v1/security/sessions/:id                POST /v1/security/sessions/revoke-others
```

### 18.2 Documentation that must be corrected before an app is written against it

These were places where `02-api.md` would have misled a client author. All of
them have since been corrected in that document; the table is kept because an
app written against an older copy of the docs will still carry the mistakes.

| Was documented | Actual, and now documented |
|---|---|
| `bootstrap` returns `conversations` and `memoryUsage` | returns `providers`, `mcp`, `prompts`, `memoryKeys`, `limits`; no conversations, so a cold start is two calls |
| `tool.start` / `tool.end` | `tool.execution.start` / `tool.execution.end` |
| `message.delta` payload `{ messageId, text }` | `{ assistantMessageEvent, modelCallIndex }` |
| `message.delta` is never persisted | persisted, then pruned after the run settles |
| messages page newest-first with a cursor | both modes exist: `?after=<seq>` tops up, `?limit=&before=` pages the tail |

### 18.3 Needed for the app, in migration order

**Phase 1 — required before the transcript screen is usable.**

1. ~~**Tail paging for messages.**~~ **Shipped.**
   `GET /v1/conversations/:id/messages?limit=<n>[&before=<seq>]` returns a page
   of the tail, oldest-first within the page, with `nextCursor` set to the
   earliest seq it returned and `null` at the start of the transcript. `after=`
   is unchanged, and asking for neither still returns the whole transcript. A
   page is extended backwards to the user message that opens its turn, so a page
   never begins on a tool result whose call is on the previous page. Covered by
   `scripts/e2e.ts`, which walks the cursor and asserts the pages tile the
   transcript exactly once.
2. ~~**Conversation list in bootstrap**, or an explicit statement that it is two
   calls.~~ **Resolved as two calls, and `02-api.md` now says so.** The list is
   paged and changes far more often than settings, so folding it into bootstrap
   would make the cheap call as volatile as the expensive one. A cold start is
   `GET /v1/bootstrap` and `GET /v1/conversations?limit=` in parallel.

**Phase 2 — required for the coding and destructive-action stories.**

3. ~~**A tool-approval channel.**~~ **Shipped, and the shape differs from what
   this section proposed.** The `confirm: true` argument is gone from
   `delete_path` entirely, because an argument the model fills in is the model
   confirming to itself. Approvals are their own durable resource keyed by tool
   call id, not a call on the run:
   `GET /v1/conversations/:id/approvals`, `GET /v1/approvals`, and
   `POST /v1/approvals/:id { approved }`; the stream carries
   `tool.approval.required` and `tool.approval.resolved`. Keying on the row
   rather than the run is what lets a phone that was closed when the question was
   asked still find and answer it, and makes a double-tap converge instead of
   racing. See §Approvals in `02-api.md` for the state machine. The app must
   fetch the pending list on open; the stream alone is not sufficient.
4. **Restore surfaced over HTTP.** Deleted and overwritten files are archived
   under the data directory with a journal, and `restore_file` exposes that to
   the model. `GET /v1/coding/trash` and `POST /v1/coding/restore` would let the
   owner recover from the app without asking the agent to do it.

**Phase 3 — quality of life.**

5. **`GET /v1/conversations/:id/runs`** so a relaunch can find an active run
   without remembering a run id.
6. **`If-None-Match` on `/v1/bootstrap`** so a resume costs a 304 instead of the
   full settings payload.
7. **A single `GET /v1/files/:id/thumbnail`** alias, so the library does not have
   to know that images and documents take different paths.

Phase 1 item 1 and Phase 2 item 3 are both shipped, so what remains blocks
nothing: a v1 of chat, files, studio, memory and settings can be built against
the API as it stands today. The app does have to implement the approval card to
use the coding tools at all — a destructive call now waits for an answer, and a
client that cannot give one will simply appear to hang for fifteen minutes
before the request expires unapproved.

## 19. Rejected alternatives

**React Native or Catalyst reuse of the web client.** The web renderer is good,
but the two hardest problems in this app — 60 fps streaming into a scroll view
that must not jump, and correct VoiceOver over a Markdown tree — are exactly the
problems a web view is worst at. The rendering *rules* are portable; the
implementation is not.

**WebSocket instead of SSE plus polling.** The server's choice, and the app
benefits: resume is an integer cursor, which is precisely what survives iOS
suspending a socket without warning.

**Local SQLite mirror of the transcript.** Tempting for offline reading, but it
duplicates the server's schema in a second place that will drift, and the
failure mode — the phone showing a transcript the server disagrees with — is
worse than the phone showing nothing. A bounded in-memory cache with disk-backed
image thumbnails covers the real use case.

**Server-side push notifications.** Needs APNs credentials on a home machine and
an Apple-reachable endpoint, which the Tailscale deployment deliberately does
not have. Local notifications scheduled from the background poll cover the
common case at zero operational cost.
