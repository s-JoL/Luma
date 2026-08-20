import Foundation

/// Everything needed to render settings and start a run, in one round trip.
/// Deliberately carries no conversations: that list is paged and changes far more
/// often than settings, so a cold start is this plus
/// `GET /conversations?limit=` in parallel (`05-api.md §启动包`).
struct Bootstrap: Decodable, Sendable {
    let version: String
    let models: [ModelSpec]
    let providers: [Provider]
    let defaultModelId: ModelId
    let profiles: [Profile]
    let defaultProfileId: String
    let capabilities: Capabilities
    let mcp: [McpStatus]
    let prompts: PromptSettings
    let memoryKeys: [String]
    let limits: Limits

    struct Limits: Decodable, Sendable {
        let maxUploadBytes: Int
        let maxAttachmentsPerMessage: Int
    }

    /// Every chat model the server knows, in the order it returned them. This is
    /// the inventory a settings list shows, unconfigured ones included, because
    /// that row is where 缺少密钥 gets said. The app does not sort or keep a model
    /// list of its own; the server's order is the order.
    var chatModels: [ModelSpec] {
        models.filter { $0.kind == .chat && $0.enabled }
    }

    /// The switcher's lists: the inventory minus anything that cannot run. Picking
    /// a model whose provider has no key fails when the run starts, and a failed
    /// send reads as the app being broken rather than as a provider being
    /// unconfigured — which is what the server derives `configured` for.
    var pinnedChatModels: [ModelSpec] {
        chatModels.filter { $0.pinned && $0.isUsable }
    }

    var allChatModels: [ModelSpec] {
        chatModels.filter { $0.isUsable }
    }

    func model(_ id: ModelId) -> ModelSpec? {
        models.first { $0.id == id }
    }
}

enum ModelKind: String, Decodable, Sendable {
    case chat, image, video, embedding, rerank

    /// A row written before generation existed carries no `kind`, and an
    /// unrecognised one must not fail the whole bootstrap.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ModelKind(rawValue: raw) ?? .chat
    }
}

enum GenerationOp: String, Decodable, Sendable {
    case textToImage = "text_to_image"
    case imageToImage = "image_to_image"
    case textToVideo = "text_to_video"
    case imageToVideo = "image_to_video"
}

struct ModelSpec: Decodable, Sendable, Identifiable, Hashable {
    let id: ModelId
    let name: String
    let providerId: ProviderId
    let model: String
    let enabled: Bool
    let kind: ModelKind
    let pinned: Bool
    let reasoning: Bool
    let contextWindow: Int
    let maxTokens: Int
    let apiMode: String
    /// Derived server-side: the provider has a usable key.
    let configured: Bool?

    /// Absent on a server that predates the field, and reading that as unusable
    /// would empty the switcher against an older deployment.
    var isUsable: Bool { configured ?? true }

    private enum CodingKeys: String, CodingKey {
        case id, name, providerId, model, enabled, kind, pinned, reasoning
        case contextWindow, maxTokens, apiMode, configured
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ModelId.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        providerId = try c.decode(ProviderId.self, forKey: .providerId)
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        kind = try c.decodeIfPresent(ModelKind.self, forKey: .kind) ?? .chat
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        reasoning = try c.decodeIfPresent(Bool.self, forKey: .reasoning) ?? false
        contextWindow = try c.decodeIfPresent(Int.self, forKey: .contextWindow) ?? 0
        maxTokens = try c.decodeIfPresent(Int.self, forKey: .maxTokens) ?? 0
        apiMode = try c.decodeIfPresent(String.self, forKey: .apiMode) ?? "openai-chat"
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured)
    }
}

struct Provider: Decodable, Sendable, Identifiable, Hashable {
    let id: ProviderId
    let name: String
    let baseUrl: String
    let hasKey: Bool
    let enabled: Bool
    let auth: AuthConfig?

    /// Bearer travels as `null`, which is also what a row that never declared a
    /// style means, so an absent or unrecognised style reads as bearer exactly
    /// as the server reads it.
    struct AuthConfig: Decodable, Sendable, Hashable {
        let style: Style
        let header: String?
        let prefix: String?

        enum Style: String, Decodable, Sendable {
            case bearer, header, none

            init(from decoder: any Decoder) throws {
                let raw = try decoder.singleValueContainer().decode(String.self)
                self = Style(rawValue: raw) ?? .bearer
            }
        }
    }

    /// A provider that declares it authenticates nobody must not be flagged as
    /// missing a key.
    var isKeyless: Bool { auth?.style == Provider.AuthConfig.Style.none }
}

struct Profile: Decodable, Sendable, Identifiable, Hashable {
    let id: ProfileId
    let name: String
    let chatModelId: String
    let imageModelId: String
    /// Empty means edits go to `imageModelId` when it supports them.
    let editModelId: String
    let videoModelId: String
    let mcpServers: [String]

    private enum CodingKeys: String, CodingKey {
        case id, name, chatModelId, imageModelId, editModelId, videoModelId, mcpServers
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ProfileId.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        chatModelId = try c.decodeIfPresent(String.self, forKey: .chatModelId) ?? ""
        imageModelId = try c.decodeIfPresent(String.self, forKey: .imageModelId) ?? ""
        editModelId = try c.decodeIfPresent(String.self, forKey: .editModelId) ?? ""
        videoModelId = try c.decodeIfPresent(String.self, forKey: .videoModelId) ?? ""
        mcpServers = try c.decodeIfPresent([String].self, forKey: .mcpServers) ?? []
    }
}

struct ProfilePatch: Encodable, Sendable {
    var name: String?
    var chatModelId: String?
    var imageModelId: String?
    var editModelId: String?
    var videoModelId: String?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(chatModelId, forKey: .chatModelId)
        try c.encodeIfPresent(imageModelId, forKey: .imageModelId)
        try c.encodeIfPresent(editModelId, forKey: .editModelId)
        try c.encodeIfPresent(videoModelId, forKey: .videoModelId)
    }

    private enum CodingKeys: String, CodingKey {
        case name, chatModelId, imageModelId, editModelId, videoModelId
    }
}

struct DefaultProfileReply: Decodable, Sendable {
    var defaultProfileId: String
}

struct Capabilities: Decodable, Sendable {
    let memory: Memory
    let files: Files
    let web: Web
    let coding: Coding
    let studio: Studio

    struct Memory: Decodable, Sendable {
        let enabled: Bool
        /// A separate switch from `enabled`: reading memories into the prompt
        /// while refusing writes is a deliberate combination.
        let writeEnabled: Bool
        let suggestedKeys: [String]
        let tokenLimit: Int
        let charLimit: Int
    }

    struct Files: Decodable, Sendable {
        let enabled: Bool
        let searchEnabled: Bool
        let mode: String
    }

    struct Web: Decodable, Sendable {
        let enabled: Bool
        let provider: String
        let baseUrl: String?
        let hasTavilyKey: Bool
    }

    struct Coding: Decodable, Sendable {
        let read: Bool
        let write: Bool
        let shell: Bool
        let workspace: String
    }

    struct Studio: Decodable, Sendable {
        let enabled: Bool
        let servers: [String]?
    }
}

struct McpStatus: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let title: String
    let enabled: Bool
    let connected: Bool
    let studioOnly: Bool?
    let tools: [String]
    let error: String?
}

struct PromptSettings: Codable, Sendable {
    var globalPrompt: String
    var toolPrompt: String
    var titleModelId: String
    var titleEnabled: Bool
}

struct PromptDefaults: Decodable, Sendable {
    var globalPrompt: String
    var toolPrompt: String
}
