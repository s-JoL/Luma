import Foundation

/// A destructive tool call held until a person decides. The model cannot create,
/// approve or skip one: the server's preflight writes it and only the decide
/// endpoint moves it out of `pending`.
///
/// `id` is the tool call id, which is what lets an approved call's tool block
/// replace the card in place, and what makes a double-tap converge instead of
/// racing.
struct Approval: Decodable, Sendable, Identifiable, Equatable {
    let id: ApprovalId
    let runId: RunId
    let conversationId: ConversationId
    let toolName: String
    /// Why it is risky: `delete`, `delete_recursive`, `overwrite`,
    /// `move_overwrite`, `shell`.
    let action: String
    /// One sentence naming exactly what will happen. Shown verbatim — the app
    /// must not paraphrase it.
    let summary: String
    /// Action-specific facts the card lists: paths, file counts, byte totals.
    let detail: JSONValue
    let status: Status
    let createdAt: Int
    let updatedAt: Int

    enum Status: String, Decodable, Sendable {
        case pending, approved, rejected, expired

        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .expired
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, runId, conversationId, toolName, action, summary, detail, status, createdAt, updatedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ApprovalId.self, forKey: .id)
        runId = try c.decodeIfPresent(RunId.self, forKey: .runId) ?? RunId("")
        conversationId = try c.decodeIfPresent(ConversationId.self, forKey: .conversationId) ?? ConversationId("")
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName) ?? "tool"
        action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        detail = try c.decodeIfPresent(JSONValue.self, forKey: .detail) ?? .null
        status = try c.decodeIfPresent(Status.self, forKey: .status) ?? .pending
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Int.self, forKey: .updatedAt) ?? 0
    }

    /// Only a pending card is answerable. A settled one shows its outcome and no
    /// buttons; one found already expired means the deadline passed unanswered,
    /// which is a refusal rather than a failure to load.
    var isAnswerable: Bool { status == .pending }

    /// The rows under the summary, in a stable order so the card does not
    /// reshuffle between renders.
    var detailRows: [(key: String, value: String)] {
        guard let fields = detail.objectValue else { return [] }
        return fields.keys.sorted().map { key in
            let value = fields[key] ?? .null
            return (key, value.stringValue ?? value.prettyPrinted)
        }
    }
}
