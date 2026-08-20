import Foundation

/// One row of a run's event log, whether it arrived over SSE or a poll. Both
/// paths carry the same rows and are driven by the same `after=<seq>` cursor, so
/// they interleave safely.
///
/// `type` is a `String` rather than an enum, and an unrecognised one is ignored:
/// a server that gains an event type must not brick an older build.
struct StoredEvent: Decodable, Sendable, Identifiable {
    let seq: Int
    let runId: RunId
    let conversationId: ConversationId
    let type: String
    let data: JSONValue
    let createdAt: Int

    var id: Int { seq }

    private enum CodingKeys: String, CodingKey { case seq, runId, conversationId, type, data, createdAt }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        runId = try c.decodeIfPresent(RunId.self, forKey: .runId) ?? RunId("")
        conversationId = try c.decodeIfPresent(ConversationId.self, forKey: .conversationId) ?? ConversationId("")
        type = try c.decode(String.self, forKey: .type)
        data = try c.decodeIfPresent(JSONValue.self, forKey: .data) ?? .null
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
    }
}

/// The names on the wire, from `src/server/agent/runtime.ts`. Two of these are
/// spelled differently in older prose: the tool events are
/// `tool.execution.start` / `.end`, not `tool.start` / `tool.end`.
enum EventType {
    static let runStarted = "run.started"
    static let messageDelta = "message.delta"
    static let messageEnd = "message.end"
    static let toolStart = "tool.execution.start"
    static let toolEnd = "tool.execution.end"
    static let approvalRequired = "tool.approval.required"
    static let approvalResolved = "tool.approval.resolved"
    static let jobProgress = "job.progress"
    static let contextCompacted = "context.compacted"
    static let conversationTitle = "conversation.title"
    static let runCompleted = "run.completed"
    static let runFailed = "run.failed"
    static let runCancelled = "run.cancelled"

    static let terminal: Set<String> = [runCompleted, runFailed, runCancelled]
}

/// The batch a polling client receives. `done` is the server saying the run has
/// settled, which is what lets a background poll stop early instead of burning
/// its remaining time.
struct EventBatch: Decodable, Sendable {
    let events: [StoredEvent]
    let done: Bool

    private enum CodingKeys: String, CodingKey { case events, done }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decodeIfPresent([StoredEvent].self, forKey: .events) ?? []
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
    }
}
