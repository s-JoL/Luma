import Foundation

/// A row from `GET /conversations/:id/messages`. `content` is a pi `AgentMessage`:
/// a string, an array of parts, or an envelope carrying both the parts and the
/// fields a tool result or a failed turn needs.
///
/// Forgiving in one direction only. Unknown parts are dropped, but a missing
/// `seq` or `role` is a decoding error, because those are what every cursor and
/// every layout decision depends on.
struct StoredMessage: Decodable, Sendable, Identifiable {
    let id: MessageId
    let seq: Int
    let role: Role
    let content: JSONValue
    let createdAt: Int

    enum Role: String, Decodable, Sendable {
        case user, assistant, toolResult, system, unknown

        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .unknown
        }
    }

    private enum CodingKeys: String, CodingKey { case id, seq, role, content, createdAt }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(MessageId.self, forKey: .id)
        seq = try c.decode(Int.self, forKey: .seq)
        role = try c.decode(Role.self, forKey: .role)
        content = try c.decodeIfPresent(JSONValue.self, forKey: .content) ?? .null
        createdAt = try c.decodeIfPresent(Int.self, forKey: .createdAt) ?? 0
    }

    /// The parts, whichever of the three shapes the row uses. Mirrors
    /// `partsOf((message.content as {content?})?.content ?? message.content)` in
    /// `src/web/messages.ts`.
    var parts: [JSONValue] {
        MessagePart.list(unwrappedContent)
    }

    /// The envelope's own fields — `toolCallId`, `isError`, `stopReason`,
    /// `errorMessage` — which sit beside the parts rather than among them.
    var envelope: JSONValue { content }

    private var unwrappedContent: JSONValue {
        if let inner = content["content"] { return inner }
        return content
    }
}

enum MessagePart {
    /// A bare string is one text part; anything that is not an array has none.
    static func list(_ content: JSONValue) -> [JSONValue] {
        switch content {
        case .string(let text):
            return text.isEmpty ? [] : [.object(["type": .string("text"), "text": .string(text)])]
        case .array(let items):
            return items
        default:
            return []
        }
    }
}
