# iPhone / iPad client — implementation design

`06-ios-app-prd.md` is the product side of this: what the app is for, what it must
never do, and what "done" means. This document is the build side. It names the
Xcode project layout, the Swift types, the exact numbers behind every screen, and
the order to build them in, so the app can be written on a Mac without going back
to the server code to guess.

Two rules run through all of it.

**The server is the product.** Every screen here already exists in `src/web/`, and
the web client is the reference behaviour. When this document and the running web
app disagree, the web app is right and this document has a bug. Nothing is
computed on the phone that the server already computes: no client-side prompt
assembly, no local tool list, no second opinion about which model is default.

**Native where native is better, identical where it is not.** The transcript, the
composer and the studio form are the same information architecture as the web,
because a person moving between the two should not have to relearn anything. But
scrolling, text selection, keyboard handling, share sheets, image saving and
Dynamic Type are UIKit/SwiftUI jobs, and the app does them the platform way
rather than reproducing a browser.

---

## 1. Targets, dependencies, project layout

### 1.1 Xcode project

One project, one app target, two test targets. Created with **Xcode 16**,
`Multiplatform → App`, then trimmed to iOS.

| Setting | Value |
|---|---|
| Product name | `Luma` |
| Bundle id | `works.earendil.luma` (change to your own reverse-DNS) |
| Deployment target | **iOS 17.0** — `@Observable`, `ScrollView` anchor APIs, `ContentUnavailableView`, `.scrollTargetBehavior` |
| Devices | iPhone, iPad |
| Interface | SwiftUI, no App Delegate |
| Language | Swift 6, strict concurrency **on** (`SWIFT_STRICT_CONCURRENCY = complete`) |
| Orientations | iPhone: portrait + both landscapes. iPad: all four |
| Supports multiple windows | Yes on iPad (`UIApplicationSupportsMultipleScenes = true`) |
| Status bar style | Default, follows appearance |
| Appearance | Follows the system; no in-app theme toggle in v1 (§4.4) |

iOS 17 rather than 18 is deliberate: nothing in the app needs an iOS 18 API, and
17 covers every device that can install the current App Store build, including
the iPad an owner keeps on a desk as a second screen.

`Info.plist` additions:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <!-- A LAN server is plain http on a .local name or a bare IP. The tunnel
       (05-remote-access.md) is https, so the exception is scoped to local
       networking and does not weaken the remote path. -->
  <key>NSAllowsLocalNetworking</key><true/>
</dict>
<key>NSLocalNetworkUsageDescription</key>
<string>连接你在电脑上运行的 Luma 服务</string>
<key>NSBonjourServices</key>
<array><string>_http._tcp</string></array>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>把生成的图片和视频存到相册</string>
<key>UIBackgroundModes</key>
<array><string>processing</string></array>
<key>CFBundleLocalizations</key>
<array><string>zh-Hans</string><string>en</string></array>
```

`NSLocalNetworkUsageDescription` and `NSBonjourServices` are what let the app
reach `http://mac.local:8090` at all on iOS 14+; without them the first request
fails with a permission error that looks like a network outage.

There is **no** `remote-notification` background mode and no push entitlement.
The app has no server to push from — the Luma process is on someone's desk behind
a residential NAT — so a finished run is discovered by resuming the stream, not
by a notification. §7.5 covers what happens while the app is suspended.

### 1.2 Swift packages

Four, all pinned. Every one of them replaces code that would otherwise have to be
written and maintained.

```
https://github.com/gonzalezreal/swift-markdown-ui   from: 2.4.1   // block Markdown
https://github.com/mgriebling/SwiftMath             from: 1.7.3   // LaTeX → CoreGraphics
https://github.com/kishikawakatsumi/KeychainAccess  from: 4.2.2   // token storage
https://github.com/apple/swift-collections          from: 1.1.0   // OrderedDictionary
```

`swift-markdown-ui` renders CommonMark + GFM to SwiftUI views with a themeable
style, which is the one large piece of the transcript that is not worth writing.
It is used for *settled* text only; the streaming tail has its own fast path
(§6.4). Note that it is in maintenance mode — its author has moved new work to
`Textual` — and that is acceptable here precisely because of that split: the
dependency only has to render blocks that will never change again, and CommonMark
is a frozen spec. If `Textual` matures, it is a drop-in for one file.

`SwiftMath` typesets LaTeX into a `UIView` (`MTMathUILabel`, wrapped in a
`UIViewRepresentable`) with no WebView and no JavaScript, which is what makes math
viable on a phone. KaTeX-in-a-WKWebView would cost a web process per formula. It
covers LaTeX math mode only, so a formula it cannot parse falls back to
monospaced source text rather than an empty box.

Deliberately **not** taken as dependencies:

- **A syntax highlighter.** The web client does not highlight code either
  (`theme.css` styles `pre` with one background and one font). Matching that is
  free; diverging costs a grammar bundle and a per-language maintenance burden.
- **An SSE library.** `URLSession.bytes(for:)` plus `.lines` is fifty lines
  (§7.2), and every library in this space either drops the `event:` name or
  reconnects with its own policy.
- **A networking library.** The API is nine resources of plain JSON.
- **An image cache.** `URLCache` with a disk capacity already does it, and the
  server already answers with immutable long-lived cache headers (`02-api.md
  §Files`). §7.6.

### 1.3 File layout

```
Luma/
  LumaApp.swift                     // @main, scene, root routing
  Info.plist
  Assets.xcassets/                  // AppIcon, AccentColor, brand mark
  Resources/
    Localizable.xcstrings           // zh-Hans base, en fallback
Core/
  Design/
    Tokens.swift                    // colours, radii, spacing, durations  (§4)
    Typography.swift                // Dynamic Type mapping
    Symbols.swift                   // one place naming every SF Symbol used
  Model/
    Ids.swift                       // typed ids (ConversationId, RunId, …)
    Bootstrap.swift                 // Bootstrap, Model, Provider, Profile, Capabilities
    Conversation.swift              // Conversation, ConversationSummary, SearchHit
    StoredMessage.swift             // the wire message + content parts
    Turn.swift                      // Turn / Part — port of src/web/messages.ts (§6)
    Event.swift                     // StoredEvent + typed payloads          (§7.3)
    Job.swift                       // JobRecord, JobInput, JobStatus
    FileRecord.swift                // library rows, facets, search hits
    Approval.swift
    Memory.swift
    APIError.swift                  // the error envelope                    (§5.3)
  Net/
    Endpoint.swift                  // path + method + body, one value per route
    APIClient.swift                 // actor: request building, decoding, retry (§5)
    ServerLocator.swift             // base URL storage + reachability probe
    Auth.swift                      // challenge, token exchange, Keychain    (§5.4)
    EventStream.swift               // SSE reader + poll fallback             (§7)
    Uploader.swift                  // multipart, background session          (§5.6)
    ImageLoader.swift               // authenticated image fetch + cache      (§7.6)
  Store/
    AppModel.swift                  // @Observable root: session, bootstrap, routing
    ConversationsStore.swift        // list, paging, search, mutations
    TranscriptStore.swift           // one per open conversation              (§8.4)
    LiveTurn.swift                  // port of LiveTurn                       (§6.3)
    JobsStore.swift                 // queue + per-job streams                (§8.7)
    LibraryStore.swift
    SettingsStore.swift
  Markdown/
    MarkdownText.swift              // settled renderer (swift-markdown-ui)
    StreamingText.swift             // tail renderer + mask                   (§6.4)
    Mask.swift                      // maskIncompleteTail port                (§6.4)
    MathView.swift                  // SwiftMath wrapper
    Citations.swift                 // anchor → chip                          (§6.5)
UI/
  Root/
    RootView.swift                  // NavigationSplitView / TabView switch   (§8.1)
    SidebarView.swift
    SignInView.swift                                                       // §8.2
  Chat/
    ConversationListView.swift                                             // §8.3
    TranscriptView.swift                                                   // §8.4
    TurnView.swift
    ToolBlockView.swift
    ApprovalCardView.swift
    ComposerView.swift                                                     // §8.5
    ModelPickerSheet.swift
    ConversationSearchView.swift
  Library/
    LibraryView.swift                                                      // §8.6
    FileDetailView.swift
    NoteEditorView.swift
  Studio/
    StudioView.swift                                                       // §8.7
    SchemaFormView.swift            // JSON-Schema driven form
    JobQueueView.swift
    GalleryGrid.swift
    AssetDetailView.swift
  Memory/
    MemoryView.swift                                                       // §8.8
  Settings/
    SettingsView.swift                                                     // §8.9
    ModelsSettingsView.swift
    ProfilesSettingsView.swift
    CapabilitiesSettingsView.swift
    PromptsSettingsView.swift
    SecuritySettingsView.swift
    ServerSettingsView.swift
  Components/
    Badge.swift  Chip.swift  SectionCard.swift  RowView.swift
    ToastHost.swift  EmptyState.swift  Spinner.swift
    LumaAsyncImage.swift  VideoPlayerView.swift  ImageViewer.swift
LumaTests/                          // unit: mask, turn builder, SSE parser, decoding
LumaUITests/                        // XCUITest: the acceptance list in 06 §Acceptance
```

The three-way split is load-bearing. `Core/` has no SwiftUI import and is what the
unit tests exercise; `Store/` is `@Observable` and owns every mutation; `UI/` is
views that read stores and call methods. A view never calls `APIClient` directly —
that is what keeps optimistic updates, error toasts and retry in one place instead
of in forty.

---

## 2. What the app talks to

Base URL is whatever the owner typed in setup, plus `/v1`. Everything is JSON,
UTF-8, timestamps are integer Unix milliseconds. `02-api.md` is the contract;
this table is only the subset the app uses, so a reader knows the whole surface
area up front.

| Screen | Calls |
|---|---|
| Sign-in | `GET /health`, `GET /auth/challenge`, `POST /auth/token` |
| Cold start | `GET /bootstrap`, `GET /conversations?limit=30` |
| Conversation list | `GET /conversations[?limit&cursor]`, `POST /conversations`, `PATCH/DELETE /conversations/:id`, `GET /conversations/search?q=` |
| Transcript | `GET /conversations/:id` (for `activeRun`), `GET /conversations/:id/messages?limit=60`, `…?after=<seq>`, `GET /conversations/:id/approvals` |
| Send / edit / regenerate | `POST /conversations/:id/runs` with `Idempotency-Key` |
| Stop / steer / continue | `POST /conversations/:id/{stop,steer,continue}` |
| Streaming | `GET /runs/:id/events?after=<seq>` (SSE) and `&mode=poll` |
| Approvals | `POST /approvals/:id { approved }`, `GET /approvals` |
| Attachments | `POST /files` (multipart `file`, `conversationId`) |
| Library | `GET /files?kind&source&q&limit&offset`, `POST /files/notes`, `GET/PUT /files/:id/text`, `POST /files/:id/reindex`, `DELETE /files/:id`, `POST /files/search` |
| Media | `GET /images/:id[?w=]`, `GET /videos/:id` (Range) |
| Studio | `GET /studio/tools`, `GET /studio/gallery?limit&offset`, `POST /studio/run` |
| Jobs | `GET /jobs?status&limit`, `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events`, `POST /jobs/:id/cancel` |
| Memory | `GET /memory`, `PUT /memory/:key`, `DELETE /memory/:key` |
| Settings | `GET/PATCH /capabilities`, `/models`, `/providers`, `/profiles`, `/prompts`, `/mcp/servers`, `/security` |

Two things the app must **not** invent:

- A model list of its own. `bootstrap.models` filtered to `kind == .chat &&
  pinned && enabled` is the chat switcher, in the order the server returned.
- A capability opinion. If `capabilities.coding.write` is false, the app renders
  the switch as off; it does not hide the coding section, and it does not refuse
  to send a message that might need it.

---

## 3. Data flow in one page

```
        ┌────────────────────────────── AppModel (@Observable, @MainActor) ─────┐
        │  session: .signedOut | .signedIn(Device)                             │
        │  bootstrap: Bootstrap?          route: Route                         │
        │  conversations: ConversationsStore                                   │
        │  jobs: JobsStore     library: LibraryStore    settings: SettingsStore│
        │  open: [ConversationId: TranscriptStore]   (LRU, max 3 kept warm)    │
        └──────────────┬──────────────────────────────────────────────────────┘
                       │ owns
        ┌──────────────▼───────────────┐        ┌──────────────────────────┐
        │ TranscriptStore              │        │ APIClient (actor)        │
        │  turns: [Turn]               │◄──────►│  request/decode/retry    │
        │  live: LiveTurn?             │        │  Idempotency-Key         │
        │  pending: [PendingSend]      │        └───────────┬──────────────┘
        │  approvals: [Approval]       │                    │
        │  lastSeq / firstSeq          │        ┌───────────▼──────────────┐
        │  follow(runId:after:) ───────┼───────►│ EventStream (SSE ⇄ poll) │
        └──────────────────────────────┘        └──────────────────────────┘
```

Rules that keep this from turning into a mess:

1. **Stores are `@MainActor`, clients are actors.** Mutation happens on the main
   actor so SwiftUI never sees a torn state; the network never touches it.
2. **The server's sequence number is the only cursor.** Not timestamps, not array
   indices. `after=` for topping up, `before=` for paging back, `fromSeq=` for
   rewind.
3. **One writer per conversation.** `TranscriptStore` is the only thing that
   appends to `turns`. The event stream hands it events; it decides what they mean.
4. **Optimistic, then reconciled.** A sent message appears instantly as a
   `PendingSend`, is replaced by the persisted user message when the transcript is
   topped up, and is marked failed in place if the POST fails.
5. **A rewind refetches.** After any `fromSeq` request the store drops everything
   and refetches the tail, because the server reuses sequence numbers across a
   rewind (`02-api.md §Editing`).

---

## 4. Design tokens

### 4.1 Colour

The web theme is `oklch` (`src/web/theme.css`). These are the same values
converted to sRGB, which is what an Asset Catalog colour set takes. Put each one
in `Assets.xcassets` as a **Color Set** with an Any/Dark pair, so the whole app
follows the system appearance with no code, and name them exactly as below.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `background` | `#FBF9F8` | `#0F1014` | window behind everything |
| `foreground` | `#1C1F25` | `#E5E8EC` | body text |
| `card` | `#FFFFFF` | `#16181D` | composer, tool block, settings rows |
| `popover` | `#FFFFFF` | `#1B1D22` | sheets, menus |
| `primary` | `#3D68CA` | `#7BA3F6` | user bubble, send, selection |
| `primaryForeground` | `#FBFCFD` | `#0F141D` | text on `primary` |
| `secondary` | `#F1F2F5` | `#222429` | chips, attachment pills |
| `secondaryForeground` | `#2A2E35` | `#E2E5E9` | text on `secondary` |
| `muted` | `#F2F4F6` | `#1F2226` | code blocks, thinking block |
| `mutedForeground` | `#646971` | `#9499A0` | labels, timestamps, tool names |
| `accent` | `#ECF0F8` | `#252B38` | hover/selected row |
| `accentForeground` | `#324263` | `#CED8EC` | text on `accent` |
| `destructive` | `#D33944` | `#EA6972` | delete, errors, rejected |
| `success` | `#2E9052` | `#66CB79` | job succeeded, approved |
| `warning` | `#D18E35` | `#EAB35F` | pending approval, degraded MCP |
| `border` | `#E1E3E6` | `#2B2E33` | hairlines |
| `input` | `#D9DBDE` | `#35383E` | field borders |
| `ring` | `#3D68CA` | `#6C90DC` | focus ring |
| `sidebar` | `#F4F5F7` | `#090B0F` | conversation rail |
| `sidebarBorder` | `#E3E5E7` | `#24262B` | rail separator |
| `sidebarAccent` | `#E9EBEF` | `#20242C` | selected conversation |

```swift
// Core/Design/Tokens.swift
extension Color {
    static let bg = Color("background")
    static let fg = Color("foreground")
    static let card = Color("card")
    static let popover = Color("popover")
    static let brand = Color("primary")            // `primary` collides with SwiftUI
    static let onBrand = Color("primaryForeground")
    static let secondaryFill = Color("secondary")
    static let onSecondary = Color("secondaryForeground")
    static let mutedFill = Color("muted")
    static let mutedFg = Color("mutedForeground")
    static let accentFill = Color("accent")
    static let onAccent = Color("accentForeground")
    static let danger = Color("destructive")
    static let ok = Color("success")
    static let warn = Color("warning")
    static let hairline = Color("border")
    static let fieldBorder = Color("input")
    static let ring = Color("ring")
    static let sidebar = Color("sidebar")
    static let sidebarLine = Color("sidebarBorder")
    static let sidebarSelected = Color("sidebarAccent")
}
```

Set `AccentColor` in the catalog to the `primary` pair. Nothing in the app names a
system colour (`.blue`, `.systemGray5`) or a literal hex: a screen that does will
be wrong in one of the two appearances, and that is the bug this table exists to
prevent.

### 4.2 Type

Dynamic Type throughout, semantic styles only — no fixed point sizes except in
the two places noted. The web's 14.5px body becomes `.body` (17pt at the default
setting): a phone is held closer than a monitor and the browser number would read
as small print.

| Role | Style | Weight | Notes |
|---|---|---|---|
| Transcript body | `.body` | regular | line spacing `+3pt` → ≈1.65 leading, matching the web |
| Transcript H1/H2/H3 | `.title3` / `.headline` / `.subheadline` | semibold | |
| User bubble | `.body` | regular | |
| Tool name, labels | `.subheadline` | medium | |
| Timestamps, counters, hints | `.caption` | regular | `mutedFg` |
| Code | `.system(.callout, design: .monospaced)` | regular | the one non-semantic size: `.callout` monospaced keeps 80 columns readable at default Dynamic Type |
| Nav title | `.headline` | semibold | inline display, never large-title (§8.1) |
| Section header | `.footnote` | medium | uppercased, `mutedFg`, tracking `+0.4` |

Cap the transcript at `.accessibility3`. Beyond that a code block cannot hold a
line and the layout stops being a transcript; the PRD's promise is that everything
*works* at accessibility sizes, not that a 60pt monospace line does not wrap.

```swift
// Core/Design/Typography.swift
extension View {
    /// Transcript prose: the web's 1.65 line-height, expressed as leading.
    func proseLeading() -> some View { lineSpacing(3) }
}
```

### 4.3 Space, radius, motion

Spacing is a 4pt grid. The named steps, and where each is right:

| Name | pt | Used for |
|---|---|---|
| `xs` | 4 | icon ↔ label inside a chip |
| `sm` | 8 | inside a bubble, between chips |
| `md` | 12 | screen side margins on iPhone, composer padding |
| `lg` | 16 | screen side margins on iPad, card padding |
| `xl` | 24 | between turns in the transcript |
| `xxl` | 32 | above an empty state |

Radii mirror `--radius: 0.625rem`:

| Name | pt | Used for |
|---|---|---|
| `sm` | 6 | badge, the bubble's tail corner |
| `md` | 8 | inline code, small buttons |
| `lg` | 10 | tool block, image, card, settings group |
| `xl` | 14 | composer |
| `bubble` | 18 | user bubble (`rounded-2xl`) |
| `pill` | ∞ | `Capsule()` for chips and the jump-to-latest pill |

Motion. Two curves and nothing else:

```swift
enum Motion {
    static let quick = Animation.easeOut(duration: 0.12)   // appear, chip toggle
    static let move  = Animation.spring(response: 0.32, dampingFraction: 0.86)
}
```

Streaming text is **not** animated. A `withAnimation` around an appended token
makes the whole paragraph re-layout on every delta and turns a 60-token/second
stream into a stutter; the text simply appears, which is also what the web does.

### 4.4 Appearance

Follows the system, both directions, no in-app toggle. The web has a toggle
because a browser tab has no system appearance to inherit reliably; an iOS app
does, and an app that ignores it is the thing people complain about. Every colour
comes from §4.1, so this is free.

---

## 5. Networking

### 5.1 Endpoint as a value

One `Endpoint` value per route keeps URL building in one place and makes the
call sites read like the API document.

```swift
// Core/Net/Endpoint.swift
struct Endpoint {
    var method = "GET"
    var path: String
    var query: [String: String?] = [:]
    var body: Data?
    var idempotencyKey: String?

    static func bootstrap() -> Endpoint { .init(path: "/bootstrap") }

    static func messages(_ id: ConversationId, limit: Int? = nil,
                         before: Int? = nil, after: Int? = nil) -> Endpoint {
        .init(path: "/conversations/\(id.raw)/messages",
              query: ["limit": limit.map(String.init),
                      "before": before.map(String.init),
                      "after": after.map(String.init)])
    }

    static func run(_ id: ConversationId, _ input: RunInput, key: String) throws -> Endpoint {
        .init(method: "POST", path: "/conversations/\(id.raw)/runs",
              body: try JSON.encode(input), idempotencyKey: key)
    }
}
```

Nil query values are dropped, so `messages(id, limit: 60)` sends
`?limit=60` and nothing else — sending `before=` empty would be a different
question (`02-api.md §Conversations`).

### 5.2 The client

```swift
// Core/Net/APIClient.swift
actor APIClient {
    private let session: URLSession
    private var base: URL          // …/v1
    private var token: String?

    init(base: URL, token: String?) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        config.urlCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 256 << 20)
        self.session = URLSession(configuration: config)
        self.base = base
        self.token = token
    }

    func send<T: Decodable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        let data = try await raw(endpoint)
        do { return try JSON.decode(T.self, from: data) }
        catch { throw APIError.decoding(String(describing: error)) }
    }

    func send(_ endpoint: Endpoint) async throws {          // 204 routes
        _ = try await raw(endpoint)
    }

    private func raw(_ endpoint: Endpoint) async throws -> Data {
        var attempt = 0
        while true {
            do { return try await once(endpoint) }
            catch let error as APIError where error.isRetryable && attempt < 2 {
                attempt += 1
                try await Task.sleep(for: .milliseconds(300 << attempt))   // 600, 1200
            }
        }
    }
}
```

Retry is narrow on purpose: transport failures and `503`, at most twice, and only
for requests that are safe to repeat — a GET, or a POST carrying an
`Idempotency-Key`. Anything else surfaces immediately. The server's own
`Idempotency-Key` handling (`02-api.md §Conventions`) is what makes a retried send
safe rather than a duplicate message, and it is the reason the app never has to
ask "did that go through?".

`waitsForConnectivity = true` plus a 30s request timeout is the combination that
makes a phone leaving a lift behave: the request waits for the radio instead of
failing, but a server that accepted the connection and then went quiet does not
hang the UI forever.

### 5.3 Errors

The server always answers with one envelope. So does the app's error type.

```swift
// Core/Model/APIError.swift
struct ServerError: Decodable, Sendable {
    let code: String
    let message: String
}

enum APIError: Error, Sendable {
    case server(status: Int, ServerError)
    case transport(URLError)
    case decoding(String)
    case unauthorized            // 401/403 → sign out
    case offline

    /// Safe to show verbatim; the server writes these for people.
    var display: String {
        switch self {
        case .server(_, let e): return e.message
        case .transport, .offline: return "连不上服务器，检查网络或服务器地址"
        case .decoding: return "服务器返回了无法识别的数据"
        case .unauthorized: return "登录已失效，请重新登录"
        }
    }

    var isRetryable: Bool {
        switch self {
        case .transport, .offline: return true
        case .server(let status, _): return status == 503 || status == 429
        default: return false
        }
    }
}
```

Three placements, and a screen picks exactly one:

- **Toast** (`ToastHost`, §9) for a failed background action: a title rename, a
  memory save, a capability toggle. Auto-dismiss 4s, tappable to retry.
- **Inline** for a failed run: the error text sits in the transcript where the
  answer would be, in `destructive` on a 10% tint, with a *重试* button. This
  matches `chat.tsx`'s `turn.error`.
- **Full screen** (`ContentUnavailableView`) only when nothing on the screen can
  work: no server configured, or signed out.

`401` and `403` are special: any response with either clears the Keychain and
routes to sign-in, from wherever it happened. A revoked device (`05-remote-access.md`)
must not be able to sit on a stale screen.

### 5.4 Auth and the Keychain

```swift
// Core/Net/Auth.swift
struct Challenge: Decodable { let totpRequired: Bool; let lockedFor: Int }
struct TokenGrant: Decodable { let token: String; let expiresAt: Int }

enum AuthStore {
    private static let keychain = Keychain(service: "works.earendil.luma")
        .accessibility(.afterFirstUnlockThisDeviceOnly)

    static var token: String? {
        get { try? keychain.get("device-token") }
        nonmutating set {
            if let newValue { try? keychain.set(newValue, key: "device-token") }
            else { try? keychain.remove("device-token") }
        }
    }
}
```

`afterFirstUnlockThisDeviceOnly` is the right accessibility class: background
polling after a resume needs the token without a passcode prompt, and the token
must not travel to another device in an iCloud backup.

Native clients send `Authorization: Bearer <token>`, never the cookie — the cookie
exists for the browser, and a native client that used it would inherit the
same-origin `Origin` requirement for writes (`02-api.md §Security`). The one
exception is `AVPlayer`, which cannot add a header; §7.7.

`deviceName` on `POST /auth/token` is `UIDevice.current.name` truncated to 40
characters, so the session list in Settings → 安全 reads *宋亮的 iPhone* rather
than a UUID.

### 5.5 Server address

A first-run screen (§8.2) takes a host and stores it in `UserDefaults`
(not the Keychain — it is not a secret, and it needs to be readable before
unlock). The field accepts what people actually type and normalises it:

| Typed | Stored |
|---|---|
| `mac.local:8090` | `http://mac.local:8090/v1` |
| `192.168.1.20:8090` | `http://192.168.1.20:8090/v1` |
| `luma.example.com` | `https://luma.example.com/v1` |
| `https://luma.example.com/v1/` | `https://luma.example.com/v1` |

Scheme defaults to `http` for a `.local` name, a bare IPv4, or an explicit
`:port`; `https` for anything else. `GET /health` is probed before the address is
accepted, and its `version` is shown, so a typo is caught here rather than at the
first message.

### 5.6 Uploads

`POST /files` is multipart with the field named `file`, plus an optional
`conversationId`. Two paths:

- **Composer attachments** go through the ordinary session, with a per-file
  progress ring in the attachment pill. `bootstrap.limits.maxUploadBytes` and
  `maxAttachmentsPerMessage` are enforced client-side *before* the picker returns,
  so the failure is "这张图太大了（上限 20 MB）" instead of a 400.
- **Library imports** (multi-select from Files or Photos) use a background
  `URLSession` with `isDiscretionary = false`, so a twelve-file import survives
  the app being backgrounded.

HEIC from the camera roll is transcoded to JPEG at quality 0.9 before upload,
capped at 2048px on the long edge. A 4:3 12MP HEIC is 3–5 MB and no vision model
sees more than about 1500px; sending the original costs seconds on a phone uplink
for nothing. Original bytes are kept for a file the user explicitly imports into
the library.

---

## 6. Transcript model

This is the part where a native client most easily drifts from the web, so it is
specified as a port rather than a design: `Core/Model/Turn.swift` and
`Store/LiveTurn.swift` are line-for-line equivalents of `src/web/messages.ts`, and
the unit tests in §12 use the same fixtures.

### 6.1 Wire shape

`GET /conversations/:id/messages` returns rows whose `content` is a pi
`AgentMessage` — a string, or an array of parts. The parts the app understands:

| `type` | Fields | Becomes |
|---|---|---|
| `text` | `text` | `.text` |
| `thinking` | `thinking` | `.thinking` (stripped of `__ENCRYPTED_REASONING__…`) |
| `image_ref` | `image_id` | `.image` |
| `video_ref` | `video_id`, `poster_image_id?` | `.video` |
| `toolCall` | `id`, `name`, `arguments` | `.tool`, `running: true` |

and on a `toolResult` row: `toolCallId`, `isError`, `content` (text parts joined,
plus any `image_ref`/`video_ref` the tool produced).

```swift
// Core/Model/StoredMessage.swift
struct StoredMessage: Decodable, Identifiable, Sendable {
    let id: String
    let seq: Int
    let role: Role            // user | assistant | toolResult | system
    let content: MessageContent
    let createdAt: Int

    enum Role: String, Decodable, Sendable { case user, assistant, toolResult, system }
}

/// `content` is either a string or an array of parts, and the array's members are
/// open-ended — an unknown part must decode and be ignored, never throw, or one
/// new server-side part type breaks every old build.
enum MessageContent: Decodable, Sendable {
    case text(String)
    case parts([ContentPart])
    case envelope(parts: [ContentPart], toolCallId: String?, isError: Bool,
                  stopReason: String?, errorMessage: String?)
}
```

Decoding is deliberately forgiving in one direction only: unknown *parts* are
dropped, but a missing `seq` or `role` is a decoding error, because those are what
every cursor and every layout decision depends on.

### 6.2 Turns

```swift
enum Part: Sendable, Equatable {
    case text(String)
    case thinking(String)
    case image(ImageId)
    case video(VideoId, poster: ImageId?)
    case tool(ToolPart)
    case approval(Approval)
}

struct Turn: Identifiable, Sendable, Equatable {
    let id: String
    let seq: Int              // rewind point for edit / regenerate
    let role: Role            // user | assistant only
    var parts: [Part]
    var error: String?
    enum Role: Sendable { case user, assistant }
}
```

`TurnBuilder.build(_ messages: [StoredMessage]) -> [Turn]` folds
text → tool → text across several model calls into **one** assistant turn, which
is how the conversation actually reads. The five rules, all ported:

1. A `user` row starts a user turn. Its `text` and any `image_ref` become parts.
2. An `assistant` row appends to the last assistant turn, creating one if the last
   turn is a user turn.
3. A `toolResult` row finds its `.tool` part by `toolCallId`, sets
   `running = false`, `isError`, and the joined text — and pushes any media it
   produced onto the enclosing assistant turn. **This is where a generated image
   comes from.** The model is asked to embed `image://…` in prose and usually
   does, but a turn where it only described the picture used to show no picture,
   which is a product defect and not a model quirk to tolerate.
4. `stopReason == "error"` sets `turn.error` to `errorMessage`, defaulting to
   `模型请求失败`.
5. Finally, **de-duplicate images**: for each turn, if the prose contains
   `image://<id>`, drop the standalone `.image` part with that id. Videos are
   never referenced from prose and are always kept.

### 6.3 The live turn

While a run streams, a `LiveTurn` accumulates parts from events and is rendered
*after* the settled turns. When the run settles, the transcript is topped up with
`?after=<seq>` and the live turn is dropped — the persisted rows are the truth, so
the live one only has to be good enough to watch.

```swift
@MainActor final class LiveTurn {
    private(set) var parts: [Part] = []
    private(set) var error: String?
    private var tools: [String: Int] = [:]        // callId → index in parts
    private var approvals: [String: Int] = [:]
    private let known: Set<String>                // tool calls already settled

    func apply(_ event: StoredEvent) { … }
    func snapshot() -> Turn { … }
}
```

Event → part:

| Event | Effect |
|---|---|
| `message.delta` `text_delta` | append to the trailing `.text`, or push one |
| `message.delta` `thinking_delta` | same for `.thinking` |
| `tool.execution.start` | push `.tool(running: true)`; if an approval card exists for this `toolCallId`, **replace it in place** |
| `tool.execution.end` | settle the tool, and push any `image_ref`/`video_ref` from the result |
| `tool.approval.required` / `.resolved` | insert or update the `.approval` part, keyed by id |
| `message.end` with `stopReason: "error"` | set `error` |
| `job.progress` | hand the `JobRecord` to `JobsStore`; the transcript shows a progress row inside the tool block |
| `context.compacted` | insert a one-line system note above the turn: `已压缩较早的对话以适应上下文` |
| `conversation.title` | update the conversation list, not the transcript |

The approval-replacement rule matters: the card carries the tool call's id
(`02-api.md §Approvals`), so when the approved call finally runs, its tool block
appears exactly where the question was instead of stacking beneath it.

`known` exists for reattachment. When the app resumes a run that started before
it opened, the stream replays `tool.execution.start` for calls already in the
settled transcript; without the guard the reader sees each tool twice.

### 6.4 Streaming text without flicker

The tail of a streaming answer routinely holds half a delimiter — `**加粗` a token
before it turns bold, or `[标题](htt` before a link closes. Rendering that raw
flashes punctuation on every message.

`Mask.maskIncompleteTail(_:)` is the port. In order:

1. If the number of lines starting with ``` or `~~~` is odd, an open fence is
   already rendering verbatim and **everything inside it is content** — return
   unchanged.
2. Split on complete code spans (fenced blocks, and inline `` `x` `` with a
   non-empty body). Only the final chunk — prose after the last closed span — can
   hold a dangling delimiter.
3. In that chunk: drop a trailing one or two backticks, then for each of `**`,
   `~~`, `` ` `` in that order, if the count is odd, remove the **last**
   occurrence.
4. If the text after the last `[` is not yet a complete `[label](url)`, show the
   label alone — or nothing at all when it is an image (`![`), since alt text is
   not prose.

```swift
// Core/Markdown/Mask.swift
enum Mask {
    static func incompleteTail(_ text: String) -> String { … }   // steps 1–4
}
```

Rendering has two paths, and the split is what keeps a long answer smooth:

- **Settled blocks** — everything up to the last blank line — are rendered by
  `swift-markdown-ui` and cached by content hash. They are never re-parsed.
- **The tail block** is rendered by `StreamingText`, which masks (above) and then
  builds an `AttributedString` with
  `.init(markdown:options:.init(interpretedSyntax: .inlineOnlyPreservingWhitespace))`
  — inline emphasis, code and links only, no block parsing, no layout tree. That
  is fast enough to run on every delta.

Deltas are also **coalesced to 20 Hz**: the store accumulates text and publishes
on a 50ms timer while a run is streaming. At 60 tokens/second this cuts SwiftUI
invalidations by two thirds and is imperceptible.

### 6.5 Citations

Tool output marks sources with `\ue202turn0file1`-style anchors, and the model
echoes them either as the literal six characters `\ue202` or as the U+E202
codepoint. Both must resolve to the same source, and the wrapper codepoints
U+E200/E201/E203/E204 must be **removed** — an unassigned private-use codepoint
draws as a tofu box on iOS exactly as it does in a browser.

`Citations.collect(from: [Turn]) -> [String: Citation]` re-reads tool results to
build the anchor → source map, so citations keep resolving after a relaunch
without persisting a second copy. A resolved anchor renders as an inline
`Capsule` chip, 20pt tall, `secondary` fill, `.caption`, showing the file name or
the URL's host; tapping a chip with a URL opens it in `SFSafariViewController`,
and one without opens the file in the library.

`turnText(_:)` — used by 复制 and 分享 — strips both the anchors and the wrappers,
so pasted text is clean.

---

## 7. Streaming

### 7.1 The state machine

```
        POST /runs → 202 { runId, seq }
                        │
                        ▼
              ┌──── streaming (SSE) ──────────────┐
              │   heartbeat ≤15s, watchdog 45s    │
              └───┬───────────┬───────────┬───────┘
      run.completed│   error   │ scenePhase = .background
       run.failed  │           │
      run.cancelled▼           ▼           ▼
              settled     backoff        polling
                          0.5→8s      mode=poll, 2s
                              │           │  (≤25s, then stop)
                              └─────┬─────┘
                                    ▼
                             resume → streaming
```

`settled` always ends with `GET …/messages?after=<lastSeq>` and dropping the live
turn. The stream is an optimisation; the transcript is the truth.

### 7.2 The SSE reader

```swift
// Core/Net/EventStream.swift
struct SSEFrame: Sendable { let event: String; let data: String }

extension APIClient {
    /// Frames from an event-stream response. Cancelling the task closes the
    /// connection, which is what a `.task(id:)` modifier gives for free.
    func frames(_ endpoint: Endpoint) -> AsyncThrowingStream<SSEFrame, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var request = try await self.request(for: endpoint)
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.timeoutInterval = 0                 // no total deadline
                let (bytes, response) = try await session.bytes(for: request)
                try Self.check(response)

                var name = "message", payload = ""
                for try await line in bytes.lines {
                    if line.isEmpty {                       // frame boundary
                        continuation.yield(SSEFrame(event: name, data: payload))
                        name = "message"; payload = ""
                    } else if line.hasPrefix("event:") {
                        name = String(line.dropFirst(6)).trimmed()
                    } else if line.hasPrefix("data:") {
                        let chunk = String(line.dropFirst(5)).trimmedLeadingSpace()
                        payload += payload.isEmpty ? chunk : "\n" + chunk
                    }
                    // `id:` is ignored: the app tracks `after` itself, which is
                    // the same number and survives a reconnect.
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
```

`bytes.lines` handles both `\n` and `\r\n`. A heartbeat frame arrives as
`event: heartbeat` with empty data and is used only to reset the watchdog.

**Watchdog.** The server heartbeats every 15s (`02-api.md §Streaming`). A stream
with no frame for 45s is dead in a way TCP will not report for minutes — a
cellular NAT dropping the flow looks exactly like a model thinking. The follower
runs a `Task.sleep(45s)` alongside, cancels the stream when it wins the race, and
reconnects with the current cursor.

**Backoff.** 0.5, 1, 2, 4, 8s, capped, reset on the first frame. Every reconnect
passes `?after=<lastSeq>`, so nothing is missed and nothing is duplicated.

### 7.3 Events

```swift
struct StoredEvent: Decodable, Sendable {
    let seq: Int
    let runId: String
    let conversationId: String
    let type: String
    let data: EventData          // decoded per `type`, unknown → .unknown
    let createdAt: Int
}
```

`type` is a `String`, not an enum, and an unrecognised one is ignored rather than
thrown. A server that gains an event type must not brick an older build — the
same reason unknown content parts are dropped in §6.1.

### 7.4 Reattaching on open

Opening a conversation that has an active run is the normal case after a relaunch:

1. `GET /conversations/:id` → `activeRun`, which is `null` or the run to resume
   plus `resumeSeq`: the last event already folded into the persisted transcript.
2. `GET /conversations/:id/messages?limit=60` → build turns.
3. `GET /conversations/:id/approvals` → seed pending cards. **The row is the truth,
   not the stream** (`02-api.md §Approvals`); a client that was closed when the
   question was asked has nothing to replay.
4. If `activeRun` is non-null, `GET /runs/:id/events?after=<activeRun.resumeSeq>`
   with `known` = every tool call id already in the transcript.

Step 4 uses the server's `resumeSeq` rather than a sequence number derived from
the messages just read. The two usually agree, but the server knows which events
it has already persisted, and a client that guesses either replays events it has
or skips events it does not.

Deltas are pruned two minutes after a run settles, so reattaching to a run that
just finished replays its text and reattaching to an old one yields the persisted
transcript — complete, minus the token-by-token animation. The app must render
both without a visible difference beyond that.

### 7.5 Background and resume

iOS suspends the app and kills the socket. The app does not fight this.

- `scenePhase → .background`: request a `UIApplication.beginBackgroundTask`, switch
  the follower to `mode=poll` at 2s, and stop after 25s or when the run settles.
  A short answer therefore completes while the app is in the pocket.
- `scenePhase → .active`: for every conversation with an active run, poll once
  with the current cursor to catch up in one round trip, then reopen the SSE
  stream. Never open a stream from the background — it will be killed mid-frame
  and the reconnect will race the suspend.
- A run that settled while suspended is discovered by that first poll, and the
  transcript tops up. No notification is involved, because there is nothing to
  push from.

### 7.6 Images

`GET /v1/images/:id` needs the `Authorization` header, so `AsyncImage` cannot be
used — it builds a bare `URLRequest`. `LumaAsyncImage` wraps a small loader:

```swift
actor ImageLoader {
    private let cache = NSCache<NSString, UIImage>()   // decoded, 64 MB
    func image(_ id: ImageId, width: Int?) async throws -> UIImage
}
```

Bytes are cached by `URLCache` (the server marks them immutable and long-lived),
decoded images by `NSCache` keyed `id@width`. Always request a width:
`?w=320` for a grid tile, `?w=1280` for the transcript and detail sheet, no `w`
only for 保存到相册 and 分享. This is what makes the gallery cheap — 350 rows cost
about 50 KB of thumbnails instead of hundreds of megabytes.

Prefetching: `GalleryGrid` and `LibraryView` prefetch the next 12 tiles when the
scroll passes 70% of the loaded page, on a `.utility` task so it never competes
with the visible ones.

### 7.7 Video

`AVPlayer` cannot be given a header, so it is given a cookie instead —
`AVURLAssetHTTPCookiesKey` is documented, and the server accepts the `luma_token`
cookie for reads. The same-origin `Origin` requirement applies only to
cookie-authenticated *writes* (`02-api.md §Security`), and playback is a read.

```swift
func videoAsset(_ id: VideoId) -> AVURLAsset {
    let cookie = HTTPCookie(properties: [
        .name: "luma_token", .value: AuthStore.token ?? "",
        .domain: base.host!, .path: "/", .secure: base.scheme == "https",
    ])!
    return AVURLAsset(url: base.appending(path: "videos/\(id.raw)"),
                      options: [AVURLAssetHTTPCookiesKey: [cookie]])
}
```

The server answers `Range` with `206`, so scrubbing works without downloading the
whole file. In the transcript a video renders as its `poster_image_id` with a play
badge and begins playback inline on tap, muted, with the standard controls; the
detail sheet gets a full `VideoPlayer` with AirPlay and Picture-in-Picture.

---

## 8. Screens

Every measurement below is for the **iPhone 14/15/16 class** (390×844pt, safe
area top 47pt, bottom 34pt) unless a wider class is called out. The two other
classes that must be checked on every screen: **iPhone SE** (375×667, no bottom
inset) and **iPad 11″** (834×1194 portrait, 1194×834 landscape).

### 8.1 Navigation

Size-class driven, one root view.

**Compact (iPhone, iPad slide-over).** A `TabView` with five tabs, because the
five destinations are peers and a phone has no room for a rail.

| Tab | Symbol | Label |
|---|---|---|
| Chat | `bubble.left.and.bubble.right` | 对话 |
| Studio | `wand.and.stars` | 创作 |
| Library | `folder` | 文件 |
| Memory | `brain` | 记忆 |
| Settings | `slider.horizontal.3` | 设置 |

The Chat tab is a `NavigationStack`: conversation list → transcript. The
transcript uses `.navigationBarTitleDisplayMode(.inline)` — a large title that
collapses on scroll steals 52pt from a screen whose whole job is text, and it
fights the transcript's own scroll position restoration.

**Regular (iPad, iPhone Pro Max landscape).** `NavigationSplitView` with three
columns:

```
┌─ 260pt ────────┬─ flexible ─────────────────┬─ 340pt (optional) ─┐
│ destinations   │ transcript / studio /      │ inspector:          │
│  + conversation│ library / memory / settings│  job queue, asset   │
│    list        │                            │  detail, file detail│
└────────────────┴────────────────────────────┴─────────────────────┘
```

Sidebar 260pt fixed (`.navigationSplitViewColumnWidth(260)`); the inspector
appears only where there is something to inspect and is dismissible. In landscape
on an 11″ iPad all three fit; in portrait the inspector becomes a sheet.

**State that survives.** `@SceneStorage` holds the selected tab, the open
conversation id, and the transcript's scroll anchor (the `seq` of the topmost
visible turn). Reopening lands where the reader left, which on a device that gets
picked up forty times a day is the difference between a tool and a toy.

### 8.2 Sign-in and setup

One screen, two steps, `ContentUnavailableView`-style centred layout, 320pt max
content width.

**Step 1 — server.** Title *连接服务器*, a single `TextField` (`.URL` keyboard,
no autocorrect, no capitalisation) with placeholder `mac.local:8090`, and a
*连接* button. On tap: normalise (§5.5), `GET /health`, and show
`已连接 · Luma <version>` — the version the server reported — in `success`, or the
error message in `destructive` on failure. A *扫描二维码* button opens `DataScannerViewController` and reads a QR the
server prints at startup — typing `192.168.1.20:8090` on a phone keyboard is where
this flow loses people.

**Step 2 — access code.** `GET /auth/challenge` first, so the second factor is
asked for up front rather than learned from a rejection. Fields: 访问码
(`SecureField`, `.oneTimeCode` off), and 动态验证码 (6-digit, `.numberPad`,
`.oneTimeCode` on) only when `totpRequired`. On `401 totp_required` the TOTP field
appears — that is a prompt, not a failure, and it does not count against the
attempt budget. On `429`, disable the button and count down `lockedFor` seconds
with 太多次尝试，请在 N 秒后重试.

Keychain write, `GET /bootstrap`, route to Chat. Total taps for the happy path
with a QR: scan, type code, done.

### 8.3 Conversation list

Compact: the Chat tab's root. Regular: the sidebar's lower section.

```
┌──────────────────────────────────────────┐
│  对话                              [＋]  │  ← nav bar, inline title
│  ┌────────────────────────────────────┐  │
│  │ 🔍 搜索对话                        │  │  ← .searchable, 36pt
│  └────────────────────────────────────┘  │
│  今天                                    │  ← section header, .footnote
│  ┌────────────────────────────────────┐  │
│  │ 五图卡点脚本怎么写            14:32│  │  ← row: 64pt
│  │ 先给你三个开场…                     │  │
│  └────────────────────────────────────┘  │
│  昨天                                    │
└──────────────────────────────────────────┘
```

**Row.** 64pt tall, 12pt side margin, 8pt vertical padding. Title `.body` medium,
one line, truncating tail. Subtitle: last message preview `.caption` `mutedFg`,
one line. Trailing: relative time `.caption2` `mutedFg` (今天 → `HH:mm`, this week
→ 周三, older → `M月d日`). A running run shows a 6pt `brand` dot instead of the
time, which is how the list answers "did that finish?" without opening anything.

**Grouping** by day, headers 今天 / 昨天 / `M月d日`, exactly as the web's
`groupByDay`.

**Swipe.** Trailing: 删除 (`destructive`, confirmation alert naming the title),
归档. Leading: 重命名 (inline `TextField` alert). Long-press context menu carries
the same three plus 复制标题.

**Search.** `.searchable(placement: .navigationBarDrawer(displayMode: .always))`,
debounced 250ms, `GET /conversations/search?q=`. Results replace the list, grouped
by conversation, each hit showing the matching message's snippet with the query
run in `brand` semibold. Tapping opens the transcript **and scrolls to that
`seq`**, flashing a 2s `ring` outline on the turn — the same affordance as the
web's highlight, and the reason `seq` is in the hit.

A blank query is not an error; it clears to the ordinary list. Note that a 1–2
character CJK query is answered by a substring scan rather than the trigram index,
so it is slower and capped — the app must not treat "slow" as "broken" and must
not add a client-side second search.

**Empty state.** `ContentUnavailableView("还没有对话", systemImage: "bubble.left.and.bubble.right", description: "问点什么，或者让它画一张图")`
plus a prominent 新对话 button.

**Paging.** `GET /conversations?limit=30`, then the returned `nextCursor` back in
`?cursor=` when the last row appears. The list is never fully loaded; a
two-year-old install has thousands.

### 8.4 Transcript

The screen the app is for. Everything here is in service of one thing: text that
is comfortable to read while it is still being written.

```
┌────────────────────────────────────────────┐
│ ◀  五图卡点脚本怎么写          [⇅] [⋯]     │ 52pt nav bar
├────────────────────────────────────────────┤
│                                            │
│            ┌───────────────────────────┐   │
│            │ 帮我写一个五图卡点的脚本  │   │ user bubble, right
│            └───────────────────────────┘   │
│                                            │
│  ▸ 思考 12 秒                              │ thinking, collapsed
│                                            │
│  好的，先定结构。**开场**要在 0.8 秒内…    │ assistant prose, full width
│                                            │
│  ┌────────────────────────────────────┐    │
│  │ 🔧 web_search  搜索推荐的采样器  ⟳ │    │ tool block
│  └────────────────────────────────────┘    │
│                                            │
│  ┌────────────────────────────────────┐    │
│  │            [generated image]       │    │ image, rounded 10
│  └────────────────────────────────────┘    │
│                                            │
│                          ┌──────────────┐  │
│                          │ ↓ 回到最新 3 │  │ jump pill
│                          └──────────────┘  │
├────────────────────────────────────────────┤
│  composer (§8.5)                           │
└────────────────────────────────────────────┘
```

**Metrics.**

| Element | Value |
|---|---|
| Content max width | 768pt, centred (matches the web's `max-w-3xl`) |
| Side margin | 16pt compact, 24pt regular |
| Between turns | 24pt |
| Within a turn | 12pt between parts |
| User bubble | max 85% of content width, `brand` fill, `onBrand` text, radius 18 with the bottom-trailing corner 6, padding 14×8 |
| Assistant prose | no bubble, no fill, full content width — an answer with code, a table and a picture in a chat bubble is a worse read, and this is what the web does |
| Image | full content width, max height 600pt, radius 10, 1pt `hairline` border, `.contentShape` for tap |
| User attachment | max 200×200pt, radius 10 |
| Code block | `muted` fill, radius 10, padding 14×12, horizontal scroll, no wrap |
| Table | horizontal `ScrollView`, `Grid`, 1pt `hairline` cells, header `muted` |

**Scrolling.** A `ScrollView` + `LazyVStack`, `.defaultScrollAnchor(.bottom)`, and
`scrollPosition(id:)` bound to turn ids. Two behaviours that are easy to get wrong
and are non-negotiable:

- **Pinned to bottom while streaming** — but only while the reader has not scrolled
  up. Scrolling up more than 40pt releases the pin and shows the jump pill; the
  pill carries the count of turns arrived since. This is the single most important
  interaction in the app: an answer that yanks the view while someone is reading
  the middle of it is unusable.
- **No jump when paging back.** Loading the previous page prepends rows, and a
  naive `LazyVStack` will jump. Capture the top visible turn's id before the
  prepend and `scrollTo(id, anchor: .top)` without animation after it.

**Turn rendering performance.** `TurnView` is `Equatable` on `(id, parts.count,
revision)`, where `revision` bumps only when that turn's content changes. Without
it, one delta re-renders every turn on screen, and a 200-turn transcript drops
frames on an A15. Settled Markdown blocks are cached by content hash in an
`NSCache` on the store, keyed `turnId#blockIndex`.

**Thinking.** A `DisclosureGroup`, collapsed by default, header `▸ 思考 N 秒` in
`.caption` `mutedFg`, body `muted` at 40% fill, radius 10, padding 12×8,
`.callout`. Auto-expands while it is the only content of a streaming turn, so a
long silent think shows something; collapses when the first text delta lands.

**Tool block.** Collapsed by default. Header 40pt: symbol (§8.4.1), tool name in
`.subheadline` medium monospaced, then `args.intent` — the sentence the model wrote
as its first argument — in `.caption` `mutedFg`, truncating. Trailing: a 14pt
`ProgressView` while running, `checkmark` in `ok` on success, `exclamationmark.triangle`
in `danger` on error. Expanded: arguments as pretty JSON and the result text, both
`.callout` monospaced in a `muted` panel, result capped at 4000 characters with a
展开全部 button. Long-press → 复制结果.

**Approval card.** `card` fill, 1.5pt `warning` border, radius 10, padding 12.
Title `.subheadline` semibold, e.g. 需要确认：删除文件. Body: `approval.summary`
verbatim in `.body` — the server writes one sentence naming exactly what will
happen, and the app must not paraphrase it. Then a `detail` grid (paths, file
count, bytes, recoverable) in `.caption` monospaced. Buttons, 44pt tall, full
width, side by side: 拒绝 (bordered, `danger` label) and 允许 (borderedProminent,
`brand`) — destructive on the *left* so it is not the thumb's default, and no
"always allow" of any kind, ever. After tapping, both disable and show a spinner
until the POST returns; the settled state is whatever the server says, because a
double-tap, a retry and two clients deciding at once all converge on the row
(`02-api.md §Approvals`). A card that expires renders greyed with 已过期.

**Turn actions.** Long-press or the `⋯` on the turn's trailing edge:

| Action | Applies to | Does |
|---|---|---|
| 复制 | both | `turnText`, citations stripped |
| 分享 | both | `ShareLink` |
| 编辑 | user | inline edit → `POST /runs { text, fromSeq: turn.seq }` |
| 重新生成 | assistant | `POST /runs { text: <previous user text>, fromSeq: <that turn's seq> }` |
| 保存到相册 | image/video parts | original bytes, `PHPhotoLibrary` |

Edit and regenerate both **rewind**, and the app must refetch the transcript from
the tail afterwards rather than topping up, because the server reuses sequence
numbers across a rewind. Before sending, an alert: 这会删除这条之后的所有内容。

**Nav bar.** Back, title (the conversation title, tap to rename inline), then a
`⇅` button opening the model/profile sheet (§8.5) and a `⋯` menu: 搜索本对话,
归档, 删除, and 上下文用量 — a small sheet showing tokens used against
`contextWindow`, since a reader who has been told the context was compacted will
want to know where they stand.

**Empty state.** Centred, 320pt: brand mark, `你好，宋亮` in `.title3`, and
`可以联网搜索、检索你的文件、生成和编辑图片与视频。` in `.subheadline`
`mutedFg` — the same sentence as the web. No suggestion chips: they date badly
and they push the composer up.

#### 8.4.1 Tool symbols

One place, one mapping, so a tool never renders as a generic wrench:

| Tool | Symbol |
|---|---|
| `web_search`, `web_fetch` | `globe` |
| `file_search` | `doc.text.magnifyingglass` |
| `generate_image`, `edit_image` | `wand.and.stars` |
| `generate_video` | `film` |
| `read_file`, `list_dir` | `doc.text` |
| `write_file`, `apply_patch` | `square.and.pencil` |
| `delete_path`, `move_path` | `trash` |
| `bash_tool` | `terminal` |
| `remember`, `forget` | `brain` |
| MCP / unknown | `puzzlepiece.extension` |

### 8.5 Composer

Docked to the bottom, above the keyboard, inside the safe area. This is the
control people touch most, and it is where a phone client is most easily worse
than a browser.

```
┌────────────────────────────────────────────┐
│ ┌──────────┐ ┌──────────┐                  │  attachment pills (if any)
│ │ 图.jpg ✕ │ │ 笔记.md ✕│                  │  28pt
│ └──────────┘ └──────────┘                  │
│ ┌────────────────────────────────────────┐ │
│ │ 说点什么…                               │ │  text, min 36 / max 220pt
│ └────────────────────────────────────────┘ │
│  ＋   Grok 4.6 ▾                      ↑    │  36pt control row
└────────────────────────────────────────────┘
```

| Element | Value |
|---|---|
| Card | `card` fill, 1pt `fieldBorder`, radius 14; border → `ring` 1.5pt when focused |
| Outer padding | 12pt sides, 12pt top, `max(12, safeAreaBottom)` bottom |
| Text view | `.body`, min height 36pt (one line), max 220pt then scrolls, 6pt inner padding |
| Send | 32pt circle, `brand` fill, `arrow.up` 15pt semibold `onBrand`; 44×44 hit target via `contentShape` |
| Attach | 32pt, `plus` in `mutedFg`, menu: 照片 / 拍照 / 文件 / 写笔记 |
| Model chip | `.caption` `mutedFg`, `chevron.down`, opens the picker sheet |
| Stop | replaces Send while a run is active: `stop.fill` in a `danger` circle |

**Send is enabled** when the trimmed text is non-empty or at least one attachment
has finished uploading. Return inserts a newline; there is no send-on-return on a
phone. Hardware keyboard on iPad: ⌘↩ sends, ⇧↩ newline, Esc clears focus.

**While a run is active** the field stays editable and Send becomes Stop. Typing
and sending during a run calls `POST /steer`, and the sent text appears in the
transcript as an ordinary user message — because that is what the server does with
it (`steeringMode: "one-at-a-time"`).

**Attachments.** `PhotosPicker` (multi, images + videos), `UIImagePickerController`
for the camera, `fileImporter` for documents. Each pill: 28pt, `secondary` fill,
radius 6, 24pt thumbnail or type glyph, name truncated to 120pt, `✕` to remove.
Upload begins immediately with a determinate ring on the thumbnail; the count is
capped at `bootstrap.limits.maxAttachmentsPerMessage`, checked before the picker
returns.

**Keyboard.** `.ignoresSafeArea(.keyboard)` is **not** used; the composer rides
the keyboard. Focus is not stolen on open — a transcript that raises the keyboard
before the reader has read anything is hostile. `.scrollDismissesKeyboard(.interactively)`
so dragging the transcript down puts the keyboard away with the finger.

**Model / profile sheet.** `.presentationDetents([.medium])`. Two sections:
预设 (profiles, `nil` = 跟随全局) and 模型 (chat kind, pinned, enabled, in server
order), each row showing name, provider and a `checkmark` on the current one.
Changing either `PATCH`es the conversation immediately; the change applies to the
next run and is stated in the row's footer, so nobody expects it to rewrite the
answer above.

### 8.6 Library

```
┌──────────────────────────────────────────┐
│  文件                             [＋]   │
│  🔍 搜索文件                             │
│  [全部 128] [文档 44] [图片 84] ...      │  facet chips, 32pt, horizontal
│  ┌────────────────────────────────────┐  │
│  │ 📄 采访稿.md          12 KB · 已索引│  │  56pt row
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

Two presentations, toggled in the nav bar and remembered per `kind` filter: a
**list** (documents) and a **grid** (images, 3 columns compact / 5 regular, 2pt
gutter, square tiles, `?w=320`).

Facet chips come from the server's `facets`, and the count on a chip is what
clicking it will show — the server computes each count with the *other* filters
applied, so the app must display them verbatim and never recompute.

Row: 56pt, type glyph 24pt, name `.body` one line, then `size · state` in
`.caption` `mutedFg` where state is 已索引 / 索引中 / 未索引. Swipe: 删除,
重新索引. Tap opens detail.

**Detail sheet.** Document: name, size, source, chunk count, indexed time, and the
extracted text in a `ScrollView` (`.callout`, selectable). A note is editable in
place — `PUT /files/:id/text`, which reindexes — and nothing else is, because
rewriting a PDF in a text view is not a thing. Image: full-bleed `LumaAsyncImage`
at `?w=1280`, pinch-zoom, provenance (provider, model, prompt, seed) in a
`muted` panel with 复制提示词, and 保存到相册 / 分享 / 删除.

**＋ menu.** 上传文件, 上传照片, 写笔记 (`POST /files/notes`).

**Search.** The nav bar `.searchable` filters by name (`?q=`). A second control —
a segmented 名称 / 语义 — switches to `POST /files/search` with
`mode: "hybrid"`, showing ranked chunk hits with their score and source document.
This is the same retrieval path the `file_search` tool uses, which is the point:
if the agent can find it, so can the reader, and vice versa.

### 8.7 Studio

Generation without a model turn. The form is **generated from the server's JSON
Schema**, which is what lets a new backend appear with no client change — the app
must not hard-code a single field for a single provider.

```
┌──────────────────────────────────────────┐
│  创作                          [队列 2]  │
│  ┌────────────────────────────────────┐  │
│  │ Lustify v10 · 本地            ▾    │  │  tool picker, 44pt
│  ├────────────────────────────────────┤  │
│  │ 提示词                             │  │  schema-driven form
│  │ ┌────────────────────────────────┐ │  │
│  │ │                                │ │  │  多行, min 88pt
│  │ └────────────────────────────────┘ │  │
│  │ 尺寸  [1024×1024 ▾]  步数 [24 ―●―] │  │
│  │ ▸ 高级                             │  │
│  ├────────────────────────────────────┤  │
│  │            开始生成                │  │  50pt, prominent
│  └────────────────────────────────────┘  │
│  ── 队列 ────────────────────────────    │
│  │ ⟳ Lustify v10  ▓▓▓▓▓░░░ 62%   ✕  │    │  44pt job row
│  ── 作品 ────────────────────────────    │
│  [ ][ ][ ]  masonry, 3 cols               │
└──────────────────────────────────────────┘
```

**Tool picker.** `GET /studio/tools`. Entries are either `model:<id>` (one per
operation, with `modelId` and `op`) or an MCP tool. Grouped 图片生成 / 图片编辑 /
视频生成, each row showing name plus a 本地 badge for a ComfyUI-backed model —
which is the *only* place local versus hosted is surfaced, because everywhere else
it is just another image API.

**Schema form.** `SchemaFormView` walks the JSON Schema:

| Schema | Control |
|---|---|
| `string` | single-line `TextField` |
| `string` + `x-multiline` or name matching `prompt` | `TextEditor`, min 88pt |
| `string` + `enum` | `Menu` picker |
| `integer`/`number` + `minimum`+`maximum` | `Slider` with a value label; `Stepper` when the range is ≤ 10 |
| `integer`/`number` unbounded | numeric `TextField` |
| `boolean` | `Toggle` |
| `string` + `x-image-ref` | image slot: tap to pick from gallery, library, or camera roll |
| `array` of image refs | horizontal slot strip, `+` to add |

`title` is the label, `description` a `.caption` `mutedFg` footnote, `default`
prefills, `required` gates the button. Fields not in the schema's first-class list
(anything after `x-advanced`, or beyond the sixth field) go under a collapsed
▸ 高级 group — a ComfyUI workflow can expose twenty node bindings and a phone
screen cannot open on twenty controls.

**Submit.** `POST /jobs` with `Idempotency-Key`, which returns immediately with a
`JobRecord` (202). The synchronous `POST /studio/run` exists for clients that want
one picture without learning the queue; the phone uses the queue, because a
two-minute video on a phone must survive the screen locking.

**Queue.** Rows 44pt: spinner or status glyph, tool name, a 4pt `brand` progress
bar, elapsed time, `✕` to cancel. One SSE stream per job
(`GET /jobs/:id/events`), opened once per job and held until it settles — the
stream carries no cursor because a job's whole state is one row, so a client that
misses everything gets the same answer from `GET /jobs/:id`.

The watcher must be keyed by job id in a dictionary held outside the view's state.
A watcher recreated whenever the job list changes will abort its own stream on the
first progress event, and the visible symptom is a bar that freezes at 40% while
the server happily finishes — this is a real bug that was found and fixed in the
web client, and the same shape will happen here.

On load, only unfinished jobs are fetched (`?status=queued`, `?status=running`).
A finished job's output is already in the gallery below, or — for video, which the
gallery does not carry — in the library.

**Gallery.** `GET /studio/gallery?limit=60&offset=`, masonry by aspect ratio (3
columns compact, 5 regular, 2pt gutter, `?w=320`). Tap → detail sheet with the
full image, provenance, 用作输入 (loads it into the current form's image slot),
保存到相册, 分享, 删除. Every asset has width and height recorded server-side —
measured from the bytes when the provider does not report them — so the masonry
never has to guess a ratio or reflow after load.

### 8.8 Memory

```
┌──────────────────────────────────────────┐
│  记忆                                    │
│  1 240 / 4 000 tokens  ▓▓▓░░░░░░         │  usage bar
│  ┌────────────────────────────────────┐  │
│  │ 称呼                          [⋯]  │  │
│  │ 宋亮，叫我老宋                     │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

`GET /memory` gives entries, `tokens`, `limit`, `charLimit`, and `suggestedKeys` —
and so do `PUT` and `DELETE`, which return the same snapshot rather than the row
they touched. So a write is one call: replace the whole store from the response
and the usage bar is correct, with no follow-up read and no locally recomputed
total to drift.

Cards, one per entry: key `.subheadline` semibold, value `.body` in an editable
`TextEditor` that grows, saving on blur with a 600ms debounce. `charLimit` is the
per-value ceiling — show the count as it approaches and refuse the save locally,
since the server answers `400 too_long` and a debounced background save is a bad
place to learn that. The usage bar turns `warning` above 80% and `danger` at the
limit, because memory is injected into every prompt and a reader should see the
cost.

`＋` offers the `suggestedKeys` not yet used, and also accepts a typed key: the
server validates the shape `^[A-Za-z0-9_-]{1,64}$` and stores anything matching
it, because what a memory should be filed under is a question about its content.
Reject a malformed key in the sheet rather than sending it, since the server
answers `400 invalid` and a sheet that dismisses on failure loses the text.
Swipe or `⋯` → 删除.

The draft state must be cleared on a successful save, not merely overwritten. A
draft dictionary that keeps its entry after the PUT will keep showing the typed
text after the server has normalised or rejected it, which reads as a save that
did not stick.

### 8.9 Settings

A `List` with `.insetGrouped` style. Sections and their sub-screens:

| Section | Rows |
|---|---|
| 服务器 | address (tap to change), version, connection state, 退出登录 |
| 模型 | 模型 (list), 供应商, 默认模型 |
| 预设 | profiles list, 默认预设 |
| 能力 | 联网搜索, 文件检索, 代码, 图片, 视频 |
| 提示词 | 全局提示词, 工具提示词, 标题模型 |
| 扩展 | MCP 服务器 + status dots |
| 安全 | 访问码, 两步验证, 设备与会话 |
| 关于 | version, build, 开源许可 |

**Models.** Grouped by provider, each row: name, `.caption` `mutedFg` with
`kind · apiMode`, and badges — 默认, 已固定, plus 缺少密钥 in `warning` **only for
a provider that needs one**. A local ComfyUI model shows 本地 · 无需密钥 and no key
field; flagging it as missing a key is wrong and is the kind of detail that makes
a settings screen untrustworthy.

Rows wrap rather than truncate at 375pt. A provider name and three badges do not
fit on one line on an SE, and the name is what the reader came for.

Tap a model → editor: 名称, 类型 (`kind`), 协议 (`apiMode`), 上下文窗口,
最大输出, 思考强度, 温度 (empty means "send nothing"), 系统提示词, 定价,
启用, 固定. 拉取模型 on a provider runs `GET /providers/:id/models` and offers the
live catalogue with the server's suggested kind, ops and API mode prefilled and
editable, multi-select → `POST /models/bulk`. Bulk-added models arrive unpinned;
an aggregator has hundreds and a person reaches for four.

**Profiles.** List with the default marked. Editor: 名称, 聊天模型, 图片模型,
视频模型, capability switches, MCP server checkboxes, and the prompt pair.
`默认预设` has a 不设置 option, and it must be reachable even when no default is
set — an empty default means "use the global settings", which is a real and
common state, not a missing value.

**Capabilities.** Switches straight onto `PATCH /capabilities`. The coding group
has 工作目录 (a path field), 读, 写, 命令行, and text stating that destructive
calls always ask. Secrets (search API keys) are `SecureField`s that write to
`PUT /capabilities/secrets/:name` and never read back — the server does not return
them, and the app must show a 已设置 badge rather than dots pretending to be a
value.

Toggles are **serialised**: one in-flight `PATCH` at a time per section, queued.
Firing three PATCHes at once against the same object loses two of them, and the
symptom is a switch that flips back a second later.

**Security.** 访问码 change (with a warning that it revokes every other session),
TOTP enrolment showing the `otpauth://` QR plus the secret to copy, confirm with a
code, and a device list with 撤销 per row and 撤销其他所有设备. Enrolment is two
steps server-side and the UI must not shortcut it: a mis-scanned QR that adopted
itself would lock the owner out.

---

## 9. Component catalog

Small, dumb, and matched to the web so both clients read the same.

| Component | Spec |
|---|---|
| `Badge` | `.caption2` medium, 6pt h / 2pt v padding, radius 6. Tones: neutral (`secondary`), brand, `ok`, `warn`, `danger`, each at 12% fill with the full-strength colour as text |
| `Chip` | `Capsule`, 32pt tall, 12pt h padding, `.caption`; selected = `accent` fill + `onAccent`; count in `mutedFg` after the label |
| `SectionCard` | `card` fill, radius 10, 1pt `hairline`, header `.footnote` medium uppercased `mutedFg` above it |
| `RowView` | 44pt min, 12pt h padding, hairline separator inset to the text, label + trailing content, **wraps** when the trailing content cannot fit |
| `ToastHost` | Bottom overlay above the composer, `popover` fill, radius 10, shadow y2 blur8 at 8% black, 4s auto-dismiss, swipe to dismiss, tap = retry |
| `EmptyState` | `ContentUnavailableView` with a 32pt symbol in `mutedFg` |
| `Spinner` | `ProgressView().controlSize(.small)`; a determinate ring where a percentage is known |
| `LumaAsyncImage` | authenticated fetch, `muted` placeholder at the known aspect ratio, 120ms cross-fade, `exclamationmark.triangle` in `mutedFg` on failure |
| `ImageViewer` | full-screen, pinch/double-tap zoom to 4×, drag to dismiss, `ShareLink` + 保存到相册 |

Every tappable thing is at least 44×44pt in hit area, using `.contentShape` where
the visual is smaller. Every icon-only control has an `accessibilityLabel`.

---

## 10. Accessibility

Not a pass at the end; these are build requirements.

- **VoiceOver.** A turn is one element that reads "我：帮我写…" or "助手：好的，先定结构…". Tool blocks read "工具 web_search，已完成" and expand as an action. An approval card reads its summary and exposes 允许 and 拒绝 as buttons, and it must be reachable by rotor as a heading, because it is the one thing in the app that blocks work.
- **Dynamic Type** to `.accessibility3` on every screen, checked at `.accessibility1` for the composer specifically — the control row must still fit at 375pt.
- **Reduce Motion** removes the cross-fade and the jump-pill spring; nothing in the app depends on motion to be understood.
- **Contrast.** The token pairs in §4.1 are the web's, which clear 4.5:1 for body text in both appearances. `Increase Contrast` swaps `mutedFg` for `fg` in secondary labels.
- **Keyboard on iPad.** Full keyboard access reaches the composer, Send, the model picker, and both approval buttons. ⌘N new conversation, ⌘F search, ⌘⇧K stop.

---

## 11. Performance budget

Measured on an iPhone 12 (A14), the slowest device worth supporting.

| Thing | Budget |
|---|---|
| Cold launch to conversation list | < 1.2s |
| Conversation open to first turn painted | < 250ms from cache, < 700ms cold |
| Streaming | 60fps with a 200-turn transcript loaded |
| Delta → glass | < 100ms (20 Hz coalescing, §6.4) |
| Gallery scroll | 60fps at 5 columns with prefetch |
| Memory | < 180 MB with a 500-turn transcript and 200 gallery tiles |

The three things that will blow this, and the defence for each: re-rendering
settled turns (`Equatable` gating, §8.4), re-parsing settled Markdown (content-hash
cache, §6.4), and decoding full-size images (always request `?w=`, §7.6).

---

## 12. Tests

**Unit (`LumaTests`)** — no network, fixtures checked in.

- `MaskTests`: every prefix of a streamed line renders and none shows a delimiter that has not closed yet. Same property as `scripts/audit-markdown.tsx`, and the same fixture set, exported to JSON.
- `TurnBuilderTests`: the message-log fixtures from a real conversation → expected turns. Covers tool folding, media from tool results, image de-duplication, error turns.
- `LiveTurnTests`: a recorded event stream (captured with `curl` against the audit instance, checked in as JSONL) replayed frame by frame; the final snapshot must equal what `TurnBuilder` produces from the settled messages. **This is the single most valuable test in the suite** — it is what keeps the live view and the persisted view from drifting.
- `SSEParserTests`: multi-line `data:`, CRLF, heartbeats, a frame split across chunk boundaries, an unknown event type.
- `DecodingTests`: every fixture in `docs/fixtures/` decodes, and an unknown content part or event type is ignored rather than thrown.
- `URLNormaliseTests`: the table in §5.5.

**UI (`LumaUITests`)** — against a real audit instance
(`scripts/restart.ps1 -DataDir data-audit`, access code `AUDITCODE`), one test per
acceptance item in `06-ios-app-prd.md §Acceptance`:

1. Sign in, send a message, watch it stream, background the app mid-run, resume, transcript is complete.
2. Kill the app mid-run, relaunch, reattach, transcript is complete.
3. Ask for a picture; the image appears in the transcript and in the library.
4. Trigger a destructive coding call; the card appears; reject; the model is told; approve the next one; the file is gone.
5. Submit a studio job; lock the screen; unlock; the job is finished and in the gallery.
6. Rotate an iPad through all four orientations on the transcript with the keyboard up.
7. Every screen at `.accessibility3` and at 375pt, no truncated label, no clipped control.

The fixtures do not exist yet; creating them is the first task of step 3 in §13.
Put them in `luma/docs/fixtures/` so both clients test against the same bytes,
generate them with one script run against the audit instance, and regenerate them
whenever `01-data-model.md` changes.

---

## 13. Build order

Each step ends somewhere demoable, and nothing is stubbed that a later step
depends on.

| # | Step | Ends with |
|---|---|---|
| 1 | Project, tokens, components, `APIClient`, `Auth` | Sign-in works against the audit instance; `/bootstrap` prints |
| 2 | `ConversationsStore` + list + paging + search | Browse and rename real conversations |
| 3 | `TurnBuilder` + `MarkdownText` + `TranscriptView`, read-only | Read any existing conversation, correctly, including code, math, images |
| 4 | `EventStream` + `LiveTurn` + `StreamingText` + composer | Send and watch. **This is the app.** |
| 5 | Reattach, background poll, stop / steer / continue, edit / regenerate | Survives a lift, a lock and a force-quit |
| 6 | Approvals | The coding path is safe to use from a phone |
| 7 | Library + attachments + image viewer | Files in, files out |
| 8 | Studio + `SchemaFormView` + jobs queue | Generation without the agent |
| 9 | Memory + Settings | Nothing needs the browser any more |
| 10 | iPad split view, keyboard shortcuts, accessibility pass, performance pass | Ship |

Steps 1–4 are the milestone that matters; everything after is additive, and each
one can ship on its own.

---

## 14. Deliberate divergences from the web client

Recorded so a future reader does not "fix" them.

- **No theme toggle.** The system decides (§4.4).
- **Larger body text.** `.body` (17pt) against the web's 14.5px (§4.2).
- **Tabs instead of a rail** on compact. Five peer destinations, no room.
- **No syntax highlighting.** Neither has it; adding it to one would split them.
- **Queue instead of `POST /studio/run`.** A phone locks its screen (§8.7).
- **Poll in the background.** A browser tab is either open or gone; an app is suspended (§7.5).
- **Images and videos transcoded on upload** at 2048px / q0.9 (§5.6).

## 15. Rejected alternatives

**A local SQLite mirror of the transcript.** Tempting for offline reading, and
wrong: the server already reuses sequence numbers across a rewind, so the mirror
would need its own reconciliation rules, and two sources of truth for a transcript
is precisely the bug class the session tree was adopted to remove
(`01-data-model.md §Transcripts`). The `URLCache` plus a warm `TranscriptStore`
covers the case people actually have — reopening a conversation they just read.

**Push notifications for finished runs.** There is no server to push from. The
Luma process is on a desk behind a NAT with no APNs credentials, and adding a
relay would put a third party between the phone and a private transcript.
Background polling (§7.5) covers a short answer, and a long one is discovered on
resume.

**A cross-platform UI layer (React Native, Flutter, Capacitor).** The web client
is already the cross-platform client and it works in Safari. A native app is only
worth building for what it does better — scroll performance under streaming, the
keyboard, text selection, Photos, Files, Dynamic Type, VoiceOver — and every one
of those is exactly what a wrapper gives up.

**WebSocket for runs.** Same answer as the server's (`02-api.md §Rejected
alternatives`): SSE plus a cursor plus a poll fallback is less machinery, and
`URLSession` gives resume for free. Steering is a POST.

**Rendering Markdown in a `WKWebView`.** Would share the web client's renderer
exactly, and would cost a web process per message, no text selection worth having,
no Dynamic Type, and a scroll view inside a scroll view. The mask (§6.4) is the
only genuinely tricky part of the renderer, and it is forty lines.
