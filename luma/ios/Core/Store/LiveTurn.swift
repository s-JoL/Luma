import Foundation

/// The turn assembled from run events while a run streams. The persisted log
/// replaces it once the run settles, so this only has to be good enough to watch
/// in real time — but it must produce the *same* turn `TurnBuilder` does from the
/// settled messages, which is what `LiveTurnTests` asserts.
///
/// A port of `LiveTurn` in `src/web/messages.ts`. Parts are values here rather
/// than the reference types the TypeScript mutates in place, so every removal
/// has to reindex; `remove(at:)` is the only place that happens.
@MainActor
final class LiveTurn {
    private(set) var parts: [Part] = []
    private(set) var error: String?

    private var toolAt: [String: Int] = [:]
    private var approvalAt: [String: Int] = [:]
    private var jobAt: [String: Int] = [:]

    /// Tool calls already visible in the settled transcript. When the app
    /// resumes a run that started before it opened, the stream replays
    /// `tool.execution.start` for calls already on screen; without this guard the
    /// reader sees each tool twice.
    private let known: Set<String>

    init(known: Set<String> = []) {
        self.known = known
    }

    /// Re-adds questions asked while this client was closed. The stream replays
    /// them too when the resume point is early enough, which is why this goes
    /// through the same idempotent path rather than pushing parts directly.
    func seed(approvals: [Approval]) {
        for approval in approvals { upsert(approval) }
    }

    func apply(_ event: StoredEvent) {
        apply(type: event.type, data: event.data)
    }

    func apply(type: String, data: JSONValue) {
        switch type {
        case EventType.messageDelta:
            guard let inner = data["assistantMessageEvent"] else { return }
            let delta = inner.text("delta")
            guard !delta.isEmpty else { return }
            switch inner.text("type") {
            case "text_delta": Parts.pushText(&parts, delta)
            case "thinking_delta": Parts.pushThinking(&parts, delta)
            default: break
            }

        case EventType.approvalRequired, EventType.approvalResolved:
            guard let approval = data["approval"]?.decode(Approval.self) else { return }
            upsert(approval)

        case EventType.jobProgress:
            // The event's payload is the job row itself.
            guard let job = data.decode(JobRecord.self) else { return }
            applyJob(job)

        case EventType.toolStart:
            let callId = data.text("toolCallId")
            guard !known.contains(callId) else { return }
            // An approved call is about to show its own block, so the question
            // it answered is replaced in place rather than stacked above.
            if let at = approvalAt.removeValue(forKey: callId) { remove(at: at) }

            let name = data.text("toolName")
            toolAt[callId] = parts.count
            parts.append(.tool(ToolPart(
                callId: ToolCallId(callId),
                name: name.isEmpty ? "tool" : name,
                args: data["args"] ?? .null
            )))

        case EventType.toolEnd:
            let callId = data.text("toolCallId")
            guard let at = toolAt[callId], at < parts.count, case .tool(var tool) = parts[at] else { return }
            tool.running = false
            tool.isError = data["isError"]?.boolValue ?? false
            let content = MessagePart.list(data["result"]?["content"] ?? .null)
            tool.result = content
                .filter { $0.text("type") == "text" }
                .map { $0.text("text") }
                .joined(separator: "\n")
            parts[at] = .tool(tool)
            // The base64 was swapped for a ref server-side, so this is the same
            // picture the settled transcript will show — and it shows now rather
            // than when the model gets around to mentioning it.
            for part in content { Parts.pushMedia(&parts, part) }

        case EventType.messageEnd:
            guard let message = data["message"],
                  message.text("role") == "assistant",
                  message.text("stopReason") == "error"
            else { return }
            let text = message.text("errorMessage")
            error = text.isEmpty ? "模型请求失败" : text

        default:
            break
        }
    }

    /// The whole turn as the transcript should render it right now.
    func snapshot() -> Turn {
        Turn(
            id: Turn.liveId,
            seq: -1,
            role: .assistant,
            parts: Parts.withoutRepeatedImages(parts),
            error: error
        )
    }

    var isEmpty: Bool { parts.isEmpty && error == nil }

    // MARK: Keyed parts

    private func upsert(_ approval: Approval) {
        if let at = approvalAt[approval.id.raw], at < parts.count {
            parts[at] = .approval(approval)
            return
        }
        approvalAt[approval.id.raw] = parts.count
        parts.append(.approval(approval))
    }

    /// A card that succeeded is dropped rather than kept: its picture arrives
    /// moments later as an image part, and showing both means the reader sees the
    /// same result twice.
    private func applyJob(_ job: JobRecord) {
        let key = job.id.raw
        if job.status == .succeeded {
            if let at = jobAt.removeValue(forKey: key) { remove(at: at) }
            return
        }
        if let at = jobAt[key], at < parts.count {
            parts[at] = .job(job)
            return
        }
        jobAt[key] = parts.count
        parts.append(.job(job))
    }

    /// Removing a part shifts every index after it, so all three maps are
    /// rewritten together. Getting this wrong shows a tool block's contents
    /// under someone else's header.
    private func remove(at index: Int) {
        guard parts.indices.contains(index) else { return }
        parts.remove(at: index)
        toolAt = toolAt.compactMapValues { shift($0, removed: index) }
        approvalAt = approvalAt.compactMapValues { shift($0, removed: index) }
        jobAt = jobAt.compactMapValues { shift($0, removed: index) }
    }

    private func shift(_ value: Int, removed: Int) -> Int? {
        if value == removed { return nil }
        return value > removed ? value - 1 : value
    }
}
