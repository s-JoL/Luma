import Foundation

/// The shapes 设置 *writes*, plus the two catalogues only it reads.
/// `Bootstrap.swift` holds everything needed to hold a conversation; nothing in
/// this file is decoded until someone opens a settings screen.
///
/// Update bodies are optional all the way down, and `JSONEncoder` drops a nil
/// rather than sending `null`. That is what lets one type serve both a filled-in
/// form and a single tapped star: `PATCH` merges onto the stored row, so a body
/// naming only `enabled` leaves the other twenty fields exactly as they were.
/// Sending the whole row from a form that never rendered `params` is how a
/// working ComfyUI binding gets erased by an unrelated edit.

// MARK: - Providers

struct ProviderAuthInput: Encodable, Sendable, Equatable {
    var style: Provider.AuthConfig.Style
    var header: String?
    var prefix: String?
}

struct ProviderInput: Encodable, Sendable {
    var id: String?
    var name: String
    var baseUrl: String
    /// Left out unless the owner typed one. The server writes the vault for any
    /// string it receives, so sending `""` alongside a renamed provider would
    /// clear a key that is working.
    var apiKey: String?
    /// Sent on every write, `null` included: an absent `auth` means *keep the
    /// stored style*, and an explicit null is the only way back to bearer.
    var auth: ProviderAuthInput?
    var enabled: Bool?

    private enum CodingKeys: String, CodingKey { case id, name, baseUrl, apiKey, auth, enabled }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(baseUrl, forKey: .baseUrl)
        try c.encodeIfPresent(apiKey, forKey: .apiKey)
        try c.encodeIfPresent(enabled, forKey: .enabled)
        if let auth {
            try c.encode(auth, forKey: .auth)
        } else {
            try c.encodeNil(forKey: .auth)
        }
    }
}

// MARK: - Models

/// A number the server should forget rather than keep. Omitting the field means
/// "leave it alone", which is right for every other control here and wrong for
/// this one: an overridden temperature could otherwise never be put back to the
/// provider's own default.
enum NumberPatch: Encodable, Sendable, Equatable {
    case clear
    case set(Double)

    func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .clear: try c.encodeNil()
        case .set(let value): try c.encode(value)
        }
    }
}

struct ModelInput: Encodable, Sendable {
    var id: String?
    var providerId: String?
    var model: String?
    var name: String?
    var kind: ModelKind?
    var ops: [GenerationOp]?
    var enabled: Bool?
    var pinned: Bool?
    var reasoning: Bool?
    var input: [String]?
    var contextWindow: Int?
    var maxTokens: Int?
    var thinkingLevel: String?
    var apiMode: String?
    var librechatCompat: Bool?
    var systemPrompt: String?
    var temperature: NumberPatch?
    /// The adapter's own settings block.
    ///
    /// Set on **create from discovery** and nowhere else. The suggestion carries
    /// the family defaults a generation row needs — sizes, whether it edits, how
    /// many sources it takes — and dropping them means an imported model that
    /// cannot render. It must never be set from the editor: that is a `PATCH`
    /// onto a stored row, and a form that did not render `params` would send a
    /// partial one and erase a working ComfyUI binding, exactly as the note at
    /// the top of this file describes.
    var params: JSONValue?
}

/// `GET /models`. The same inventory `bootstrap` carries, read again because
/// these screens also need the three generation slots and because a list that
/// has just been written to should show the write, not the snapshot the app
/// started with.
struct ModelCatalogue: Decodable, Sendable {
    var items: [ModelSpec] = []
    var defaultModelId = ""
    var generation = GenerationDefaults()

    init() {}

    private enum CodingKeys: String, CodingKey {
        case items, defaultModelId, defaultImageModelId, defaultEditModelId, defaultVideoModelId
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([ModelSpec].self, forKey: .items) ?? []
        defaultModelId = try c.decodeIfPresent(String.self, forKey: .defaultModelId) ?? ""
        generation = GenerationDefaults(
            image: try c.decodeIfPresent(String.self, forKey: .defaultImageModelId) ?? "",
            edit: try c.decodeIfPresent(String.self, forKey: .defaultEditModelId) ?? "",
            video: try c.decodeIfPresent(String.self, forKey: .defaultVideoModelId) ?? ""
        )
    }
}

/// The three slots the agent and a fresh 创作台 form start from. An empty id is
/// not "unset" so much as "let the server pick a usable backend", which is what
/// it does when the slot names nothing.
struct GenerationDefaults: Decodable, Sendable, Equatable {
    var image = ""
    var edit = ""
    var video = ""

    init(image: String = "", edit: String = "", video: String = "") {
        self.image = image
        self.edit = edit
        self.video = video
    }

    private enum CodingKeys: String, CodingKey {
        case defaultImageModelId, defaultEditModelId, defaultVideoModelId
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        image = try c.decodeIfPresent(String.self, forKey: .defaultImageModelId) ?? ""
        edit = try c.decodeIfPresent(String.self, forKey: .defaultEditModelId) ?? ""
        video = try c.decodeIfPresent(String.self, forKey: .defaultVideoModelId) ?? ""
    }
}

struct GenerationDefaultsInput: Encodable, Sendable {
    var imageModelId: String?
    var editModelId: String?
    var videoModelId: String?
}

/// One entry of a provider's live catalogue. The suggestion is a starting point
/// read off the remote id, never a verdict — no pattern over aggregator ids is
/// right for every aggregator — so it is what the import writes and what the
/// editor then lets you correct.
struct DiscoveredModel: Decodable, Sendable, Identifiable, Hashable {
    let model: String
    let added: Bool
    /// Remote id of a generate model that already carries this one as its edit
    /// half. Seedream lists a `-edit` twin beside the model it belongs to, and
    /// adding both would put two rows in the catalogue for one thing — so a
    /// covered row is not offered at all.
    let coveredBy: String?
    let suggestion: Suggestion

    var id: String { model }

    /// Whether this row is worth showing. A model already in the catalogue is
    /// shown but disabled, so the reader can see it is there; one that is only
    /// the other half of a model in the same list is not a row at all.
    var isOfferable: Bool { coveredBy == nil }

    struct Suggestion: Decodable, Sendable, Hashable {
        let id: String
        let name: String
        let kind: ModelKind
        let ops: [GenerationOp]
        let apiMode: String
        let reasoning: Bool
        let input: [String]
        let contextWindow: Int
        let maxTokens: Int
        /// Family defaults for a generation row — sizes, whether it edits, how
        /// many sources it takes. Opaque on purpose: the shape belongs to the
        /// adapter, and a client that understood it would have to be released
        /// every time a new backend shipped. It is carried through to the write
        /// unread.
        let params: JSONValue?

        private enum CodingKeys: String, CodingKey {
            case id, name, kind, ops, apiMode, reasoning, input, contextWindow, maxTokens, params
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
            name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
            kind = try c.decodeIfPresent(ModelKind.self, forKey: .kind) ?? .chat
            ops = GenerationOp.known(try c.decodeIfPresent([String].self, forKey: .ops) ?? [])
            apiMode = try c.decodeIfPresent(String.self, forKey: .apiMode) ?? "openai-chat"
            reasoning = try c.decodeIfPresent(Bool.self, forKey: .reasoning) ?? false
            input = try c.decodeIfPresent([String].self, forKey: .input) ?? ["text"]
            contextWindow = try c.decodeIfPresent(Int.self, forKey: .contextWindow) ?? 128_000
            maxTokens = try c.decodeIfPresent(Int.self, forKey: .maxTokens) ?? 8192
            params = try c.decodeIfPresent(JSONValue.self, forKey: .params)
        }
    }

    /// What `POST /models/bulk` should store for this row. Adding in bulk
    /// deliberately does not pin: a dozen ticks would otherwise rearrange the
    /// chat switcher, and pinning is a decision made one star at a time.
    func input(providerId: ProviderId) -> ModelInput {
        ModelInput(
            id: suggestion.id,
            providerId: providerId.raw,
            model: model,
            name: suggestion.name,
            kind: suggestion.kind,
            ops: suggestion.ops,
            enabled: true,
            pinned: false,
            reasoning: suggestion.reasoning,
            input: suggestion.input,
            contextWindow: suggestion.contextWindow,
            maxTokens: suggestion.maxTokens,
            thinkingLevel: suggestion.reasoning ? "high" : "off",
            apiMode: suggestion.apiMode,
            params: suggestion.params
        )
    }
}

struct DiscoveredModels: Decodable, Sendable {
    let items: [DiscoveredModel]
}

struct ModelImport: Encodable, Sendable {
    let providerId: String
    let models: [ModelInput]
}

struct ModelImportResult: Decodable, Sendable {
    var added: [String] = []
    var skipped: [String] = []
}

// MARK: - MCP

/// A configured MCP server, as opposed to `McpStatus`, which is what that
/// configuration currently amounts to. Both are needed on one row: the record
/// is what an edit writes back, and only the status knows whether it connected.
struct McpServerRecord: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let title: String
    let enabled: Bool
    /// Empty for a remote server. Which of `command` and `url` is filled is what
    /// selects the transport, so they are never both meaningful at once.
    let command: String
    let url: String?
    let args: [String]
    let env: [String: String]
    let headers: [String: String]?

    var isRemote: Bool { !(url ?? "").isEmpty }

    private enum CodingKeys: String, CodingKey {
        case id, title, enabled, command, url, args, env, headers
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        url = try c.decodeIfPresent(String.self, forKey: .url)
        args = try c.decodeIfPresent([String].self, forKey: .args) ?? []
        env = try c.decodeIfPresent([String: String].self, forKey: .env) ?? [:]
        headers = try c.decodeIfPresent([String: String].self, forKey: .headers)
    }
}

struct McpServerList: Decodable, Sendable {
    var items: [McpServerRecord] = []
    var status: [McpStatus] = []
}

struct McpServerInput: Encodable, Sendable {
    var id: String?
    var title: String?
    var enabled: Bool?
    var command: String?
    var url: String?
    var args: [String]?
    var env: [String: String]?
    var headers: [String: String]?
}

// MARK: - Capabilities

/// A partial write of `PATCH /capabilities`. The server merges each group onto
/// the stored one, so a section saves the fields it shows and cannot reset a
/// neighbouring section it never rendered.
struct CapabilitiesPatch: Encodable, Sendable {
    var memory: Memory?
    var files: Files?
    var web: Web?
    var coding: Coding?
    var embedding: Embedding?
    var studio: Studio?

    struct Memory: Encodable, Sendable {
        var enabled: Bool?
        var writeEnabled: Bool?
        var suggestedKeys: [String]?
        var tokenLimit: Int?
        var charLimit: Int?
    }

    struct Files: Encodable, Sendable {
        var enabled: Bool?
        var searchEnabled: Bool?
        var mode: String?
    }

    struct Web: Encodable, Sendable {
        var enabled: Bool?
        var provider: String?
        var baseUrl: String?
    }

    struct Coding: Encodable, Sendable {
        var read: Bool?
        var write: Bool?
        var shell: Bool?
        var workspace: String?
    }

    struct Embedding: Encodable, Sendable {
        var enabled: Bool?
        var baseUrl: String?
        var model: String?
        var chunkSize: Int?
        var chunkOverlap: Int?
    }

    struct Studio: Encodable, Sendable {
        var enabled: Bool?
    }
}

// MARK: - Fixed vocabularies

/// The wire protocols a model can be called with, mirrored from
/// `shared/types.ts`. Nothing on `/v1` publishes this list — it decides which
/// adapter runs, so it ships with the server rather than being configured — and
/// a client that guessed instead would offer modes the server cannot honour.
/// A new adapter therefore needs a line here, which is the one place `06-clients.md`
/// says an App release is unavoidable.
enum ApiModes {
    struct Option: Identifiable, Sendable {
        let id: String
        let label: String
        let path: String
        let kinds: [ModelKind]
    }

    static let all: [Option] = [
        Option(id: "openai-chat", label: "对话（Chat Completions）", path: "/chat/completions", kinds: [.chat]),
        Option(id: "openai-responses", label: "对话（Responses）", path: "/responses", kinds: [.chat]),
        Option(id: "anthropic-messages", label: "对话（Anthropic）", path: "/messages", kinds: [.chat]),
        Option(id: "google-generative", label: "对话（Gemini 原生）", path: "/v1beta/models", kinds: [.chat]),
        Option(id: "openai-images", label: "图像", path: "/images/generations", kinds: [.image]),
        Option(id: "comfy-workflow", label: "ComfyUI", path: "/prompt", kinds: [.image, .video]),
        Option(id: "openai-videos", label: "视频", path: "/videos", kinds: [.video]),
        Option(id: "venice-videos", label: "视频（Venice Queue）", path: "/video/queue", kinds: [.video]),
        Option(id: "venice-images", label: "图像（Venice）", path: "/image/generate", kinds: [.image]),
    ]

    static let chat: [Option] = all.filter { $0.kinds.contains(.chat) }

    static func label(_ id: String) -> String {
        all.first { $0.id == id }?.label ?? id
    }

    static func path(_ id: String) -> String {
        all.first { $0.id == id }?.path ?? ""
    }
}

enum ThinkingLevels {
    static let all = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
}

enum SearchProviders {
    static let all: [(id: String, label: String)] = [
        ("tavily", "Tavily"),
        ("searxng", "SearXNG（自托管）"),
    ]

    static func label(_ id: String) -> String {
        all.first { $0.id == id }?.label ?? id
    }
}

enum FileSearchModes {
    static let all: [(id: String, label: String)] = [
        ("hybrid", "混合"),
        ("semantic", "仅语义"),
        ("keyword", "仅关键词"),
    ]

    static func label(_ id: String) -> String {
        all.first { $0.id == id }?.label ?? id
    }
}
