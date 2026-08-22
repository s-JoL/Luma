import Foundation

struct ToolPart: Sendable, Equatable {
    let callId: ToolCallId
    let name: String
    let args: JSONValue
    var result: String = ""
    var isError: Bool = false
    var running: Bool = true
}

enum Part: Sendable, Equatable {
    case text(String)
    case thinking(String)
    case image(ImageId)
    case video(VideoId, poster: ImageId?, durationMs: Int?)
    /// A document the reader attached — anything that is neither picture nor
    /// clip. It carries its own name because there is no thumbnail to recognise
    /// it by, and the size because a name alone does not say what it will cost
    /// to open.
    case file(FileId, name: String, bytes: Int?)
    case tool(ToolPart)
    case approval(Approval)
    case job(JobRecord)
}

struct Turn: Sendable, Equatable, Identifiable {
    let id: String
    /// Sequence of the turn's first message — the rewind point for edit and
    /// regenerate.
    let seq: Int
    let role: Role
    var parts: [Part]
    var error: String?
    /// Which live turn this is, counted from launch.
    ///
    /// The live turn's `id` is a constant, which is what the transcript wants —
    /// one row that keeps its identity as the answer grows. The streaming render
    /// cache wants the opposite: it memoises on the length of the settled prose,
    /// which is only a safe key while the prose can do nothing but grow. A rewind
    /// replaces the live turn with different prose under the same id, so this
    /// distinguishes them. Zero for everything read back from the message log,
    /// which is settled and never memoised this way.
    var generation: Int = 0

    enum Role: Sendable, Equatable { case user, assistant }

    /// The live turn is rendered after the settled ones and dropped when the run
    /// settles, so it needs an id that can never collide with a persisted row.
    static let liveId = "live"
    var isLive: Bool { id == Turn.liveId }
}

// MARK: - Building turns from the persisted log

/// Folds text → tool → text across several model calls into one assistant turn,
/// which is how the conversation actually reads. A line-for-line port of
/// `buildTurns` in `src/web/messages.ts`; the two must not drift, because the
/// same answer is read in both clients.
enum TurnBuilder {
    static func build(_ messages: [StoredMessage]) -> [Turn] {
        var turns: [Turn] = []
        /// callId → where that tool part lives, so a `toolResult` arriving any
        /// number of messages later can settle it.
        var toolIndex: [String: (turn: Int, part: Int)] = [:]

        for message in messages {
            let parts = message.parts
            let envelope = message.envelope

            switch message.role {
            case .user:
                var turn = Turn(id: message.id.raw, seq: message.seq, role: .user, parts: [])
                for part in parts {
                    if part.text("type") == "text" { Parts.pushText(&turn.parts, part.text("text")) }
                    Parts.pushMedia(&turn.parts, part)
                }
                turns.append(turn)

            case .toolResult:
                let callId = envelope.text("toolCallId")
                guard let at = toolIndex[callId], at.turn < turns.count,
                      at.part < turns[at.turn].parts.count,
                      case .tool(var tool) = turns[at.turn].parts[at.part]
                else { continue }

                tool.running = false
                tool.isError = envelope["isError"]?.boolValue ?? false
                tool.result = parts
                    .filter { $0.text("type") == "text" }
                    .map { $0.text("text") }
                    .joined(separator: "\n")
                turns[at.turn].parts[at.part] = .tool(tool)

                // What the tool actually produced. The model is asked to embed
                // the picture in its answer and usually does, but a turn where
                // it only described the picture used to show no picture at all,
                // so the tool result is where the transcript takes it from.
                if let last = turns.indices.last, turns[last].role == .assistant {
                    for part in parts { Parts.pushMedia(&turns[last].parts, part) }
                }

            case .assistant:
                if turns.last?.role != .assistant {
                    turns.append(Turn(id: message.id.raw, seq: message.seq, role: .assistant, parts: []))
                }
                let index = turns.count - 1

                if envelope.text("stopReason") == "error" {
                    let message = envelope.text("errorMessage")
                    turns[index].error = message.isEmpty ? "模型请求失败" : message
                }

                for part in parts {
                    switch part.text("type") {
                    case "text":
                        Parts.pushText(&turns[index].parts, part.text("text"))
                    case "thinking":
                        let text = Parts.strippedReasoning(part.text("thinking"))
                        if !text.isEmpty { turns[index].parts.append(.thinking(text)) }
                    case "toolCall":
                        let callId = part.text("id")
                        let name = part.text("name")
                        toolIndex[callId] = (index, turns[index].parts.count)
                        turns[index].parts.append(.tool(ToolPart(
                            callId: ToolCallId(callId),
                            name: name.isEmpty ? "tool" : name,
                            args: part["arguments"] ?? .null
                        )))
                    default:
                        break
                    }
                    Parts.pushMedia(&turns[index].parts, part)
                }

            case .system, .unknown:
                continue
            }
        }

        for index in turns.indices {
            turns[index].parts = Parts.withoutRepeatedImages(turns[index].parts)
        }
        return turns
    }
}

// MARK: - Shared part operations

/// The operations `TurnBuilder` and `LiveTurn` both need. They live here rather
/// than being written twice, because the whole point of `LiveTurnTests` is that
/// the live view and the persisted view agree.
enum Parts {
    static func pushText(_ parts: inout [Part], _ text: String) {
        guard !text.isEmpty else { return }
        if case .text(let existing) = parts.last {
            parts[parts.count - 1] = .text(existing + text)
        } else {
            parts.append(.text(text))
        }
    }

    static func pushThinking(_ parts: inout [Part], _ text: String) {
        guard !text.isEmpty else { return }
        if case .thinking(let existing) = parts.last {
            parts[parts.count - 1] = .thinking(existing + text)
        } else {
            parts.append(.thinking(text))
        }
    }

    /// The refs a message carries in either role's content: what the tools
    /// appended, and what the reader attached. A ref the app does not know is
    /// skipped rather than rejected, so an older client keeps working against a
    /// server that has learned a new one.
    static func pushMedia(_ parts: inout [Part], _ part: JSONValue) {
        switch part.text("type") {
        case "image_ref":
            parts.append(.image(ImageId(part.text("image_id"))))
        case "video_ref":
            let poster = part.text("poster_image_id")
            parts.append(.video(
                VideoId(part.text("video_id")),
                poster: poster.isEmpty ? nil : ImageId(poster),
                durationMs: part["duration_ms"]?.intValue
            ))
        case "file_ref":
            let id = part.text("file_id")
            guard !id.isEmpty else { return }
            let name = part.text("name")
            parts.append(.file(
                FileId(id),
                name: name.isEmpty ? id : name,
                bytes: part["bytes"]?.intValue
            ))
        default:
            break
        }
    }

    /// Providers append an opaque blob to reasoning text that is not prose and
    /// must never be shown.
    static func strippedReasoning(_ text: String) -> String {
        guard let marker = text.range(of: "__ENCRYPTED_REASONING__") else {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return String(text[text.startIndex..<marker.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `image://img_…` as the model writes it when embedding a picture in prose.
    private static let inlineImage = try! NSRegularExpression(
        pattern: "image://(img_[0-9a-f]{32})", options: [.caseInsensitive]
    )

    /// Every picture once. The tool result is where a generated image reliably
    /// is, so that is what the transcript shows; where the model also placed the
    /// image in its answer, the standalone copy is the second one and goes.
    /// Videos are never referenced from prose, so they are always kept.
    static func withoutRepeatedImages(_ parts: [Part]) -> [Part] {
        guard parts.contains(where: { if case .image = $0 { return true } else { return false } })
        else { return parts }

        let prose = parts.map { if case .text(let text) = $0 { text } else { "" } }.joined(separator: "\n")
        let range = NSRange(prose.startIndex..., in: prose)
        let inlined = Set(inlineImage.matches(in: prose, range: range).compactMap { match -> String? in
            guard let captured = Range(match.range(at: 1), in: prose) else { return nil }
            return prose[captured].lowercased()
        })
        guard !inlined.isEmpty else { return parts }

        return parts.filter { part in
            if case .image(let id) = part { return !inlined.contains(id.raw.lowercased()) }
            return true
        }
    }
}

// MARK: - Reading a turn

extension Turn {
    /// Plain text, with citation markers dropped so it pastes cleanly.
    var plainText: String {
        let joined = parts.map { if case .text(let text) = $0 { text } else { "" } }.joined()
        return Citations.stripMarkers(joined)
    }

    /// Every file this turn carried, by id. Edit and regenerate re-send exactly
    /// this list, so narrowing it to images is how an attachment that was not a
    /// picture used to disappear from the replayed turn.
    var attachmentIds: [String] {
        parts.compactMap { part in
            switch part {
            case .image(let id): id.raw
            case .video(let id, _, _): id.raw
            case .file(let id, _, _): id.raw
            default: nil
            }
        }
    }
}

extension Array where Element == Turn {
    /// Tool calls already in the settled transcript. A reattaching client passes
    /// these to `LiveTurn` so a replayed `tool.execution.start` does not show the
    /// reader the same tool twice.
    var toolCallIds: Set<String> {
        var ids: Set<String> = []
        for turn in self {
            for part in turn.parts {
                if case .tool(let tool) = part { ids.insert(tool.callId.raw) }
            }
        }
        return ids
    }
}
