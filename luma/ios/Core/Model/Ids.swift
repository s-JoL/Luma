import Foundation

/// Typed ids. Every one of these is a `String` on the wire and they are trivially
/// swappable at a call site, which is the whole reason to give them types: the
/// transcript passes conversation, run, message, tool-call and image ids through
/// the same functions.
protocol RawId: Hashable, Sendable, Codable, Identifiable, CustomStringConvertible {
    var raw: String { get }
    init(_ raw: String)
}

extension RawId {
    var id: String { raw }
    var description: String { raw }

    init(from decoder: any Decoder) throws {
        self.init(try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(raw)
    }
}

struct ConversationId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct RunId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct MessageId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct ToolCallId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct ImageId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct VideoId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct FileId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct ModelId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct ProviderId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct ApprovalId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
struct JobId: RawId { let raw: String; init(_ raw: String) { self.raw = raw } }
