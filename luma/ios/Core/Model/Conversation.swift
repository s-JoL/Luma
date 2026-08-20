import Foundation

/// A row in the conversation list. This is the whole payload — there is no
/// last-message preview and no active-run flag, and the list screen must not
/// synthesise either, because both cost one request per visible row
/// (`06-clients.md §iOS`).
struct ConversationSummary: Decodable, Sendable, Identifiable, Hashable {
    let id: ConversationId
    let title: String
    let modelId: ModelId
    let profileId: String
    let createdAt: Int
    let updatedAt: Int
    let messageCount: Int

    private enum CodingKeys: String, CodingKey {
        case id, title, modelId, profileId, createdAt, updatedAt, messageCount
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ConversationId.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        modelId = try c.decodeIfPresent(ModelId.self, forKey: .modelId) ?? ModelId("")
        profileId = try c.decodeIfPresent(String.self, forKey: .profileId) ?? ""
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Int.self, forKey: .updatedAt) ?? 0
        messageCount = try c.decodeIfPresent(Int.self, forKey: .messageCount) ?? 0
    }

    var displayTitle: String { ConversationTitle.display(title) }
}

/// A conversation is created with the server's placeholder and renamed a few
/// seconds later, when the title model answers. Both the empty string and that
/// placeholder mean "not named yet", and showing the English default in a
/// Chinese UI for those few seconds looks like a bug.
enum ConversationTitle {
    static let placeholder = "New conversation"

    static func display(_ title: String?) -> String {
        let trimmed = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == placeholder ? "新对话" : trimmed
    }
}

/// `GET /conversations/:id`. `activeRun` is what a relaunch reattaches to, and
/// its `resumeSeq` is the server's own watermark rather than something derived
/// from the messages just read.
struct ConversationDetail: Decodable, Sendable {
    let id: ConversationId
    let title: String
    let modelId: ModelId
    let profileId: String
    let activeRun: ActiveRun?

    struct ActiveRun: Decodable, Sendable {
        let id: RunId
        let status: RunStatus
        let resumeSeq: Int
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, modelId, profileId, activeRun
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ConversationId.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        modelId = try c.decodeIfPresent(ModelId.self, forKey: .modelId) ?? ModelId("")
        profileId = try c.decodeIfPresent(String.self, forKey: .profileId) ?? ""
        activeRun = try c.decodeIfPresent(ActiveRun.self, forKey: .activeRun)
    }
}

enum RunStatus: String, Decodable, Sendable {
    case queued, running, completed, failed, cancelled

    /// A status this build has not heard of reads as terminal rather than failing
    /// the decode: the run is over as far as this client can tell, and a stuck
    /// spinner is a worse answer than an unrecognised ending.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunStatus(rawValue: raw) ?? .completed
    }

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: true
        case .queued, .running: false
        }
    }
}

struct RunSummary: Decodable, Sendable, Identifiable {
    let id: RunId
    let conversationId: ConversationId
    let status: RunStatus
    let modelId: ModelId
    let error: String?
}

/// `POST /conversations/:id/runs` answers with the watermark *before* the run
/// produced anything, so a client can start streaming without racing the first
/// event. Using 0 here would replay the entire event table (`05-api.md §对话`).
struct RunAccepted: Decodable, Sendable {
    let runId: RunId
    let seq: Int
}

struct ConversationSearchHit: Decodable, Sendable, Identifiable, Hashable {
    let conversationId: ConversationId
    let title: String
    let seq: Int
    let role: String
    let snippet: String
    let createdAt: Int

    var id: String { "\(conversationId.raw)#\(seq)" }
}

/// The wire shape of every list endpoint. `nextCursor` is opaque: a client echoes
/// it back rather than computing the next one (`05-api.md §约定`).
struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let nextCursor: String?

    private enum CodingKeys: String, CodingKey { case items, nextCursor }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([Item].self, forKey: .items) ?? []
        // Messages page with an integer cursor, conversations with a stamp, the
        // library with an offset. All three are opaque to the client, so the
        // number is read back as its own text rather than as a second type.
        if let text = try? c.decodeIfPresent(String.self, forKey: .nextCursor) {
            nextCursor = text
        } else if let number = try? c.decodeIfPresent(Int.self, forKey: .nextCursor) {
            nextCursor = String(number)
        } else {
            nextCursor = nil
        }
    }
}
