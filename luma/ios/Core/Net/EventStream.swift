import Foundation

struct SSEFrame: Sendable {
    let event: String
    let data: String
}

/// Bytes to frames. It has to be written over bytes rather than over
/// `AsyncLineSequence`, because that sequence *drops empty lines* — and an empty
/// line is the only thing that ends an SSE frame. Reading the stream line by
/// line therefore never saw a frame boundary at all: every `event:`/`data:` pair
/// ran into the next, nothing was ever dispatched, and a run showed no text
/// until it finished and the transcript was re-read from the message log. That
/// is the whole reason a streaming client looked like a batching one.
struct SSEParser {
    private var line: [UInt8] = []
    private var name = "message"
    private var payload = ""
    /// The previous byte was a CR, so an LF now is the other half of one break
    /// rather than a second, empty line.
    private var afterCarriageReturn = false

    private static let lineFeed: UInt8 = 0x0A
    private static let carriageReturn: UInt8 = 0x0D

    mutating func consume(_ byte: UInt8) -> SSEFrame? {
        switch byte {
        case Self.lineFeed where afterCarriageReturn:
            afterCarriageReturn = false
            return nil
        case Self.lineFeed, Self.carriageReturn:
            afterCarriageReturn = byte == Self.carriageReturn
            return endOfLine()
        default:
            afterCarriageReturn = false
            line.append(byte)
            return nil
        }
    }

    private mutating func endOfLine() -> SSEFrame? {
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)

        if text.isEmpty { return dispatch() }
        // A line beginning with a colon is a comment, which is how a server keeps
        // an idle connection warm without meaning anything by it.
        if text.hasPrefix(":") { return nil }

        if text.hasPrefix("event:") {
            name = String(text.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if text.hasPrefix("data:") {
            var chunk = String(text.dropFirst(5))
            if chunk.hasPrefix(" ") { chunk.removeFirst() }
            payload += payload.isEmpty ? chunk : "\n" + chunk
        }
        // `id:` and `retry:` are ignored: the app tracks `after` itself, which is
        // the same number and survives a reconnect.
        return nil
    }

    /// A blank line ends the frame. A blank line with nothing before it is
    /// padding rather than an event, so it dispatches nothing.
    private mutating func dispatch() -> SSEFrame? {
        defer {
            name = "message"
            payload = ""
        }
        guard !payload.isEmpty || name != "message" else { return nil }
        return SSEFrame(event: name, data: payload)
    }
}

extension APIClient {
    /// Frames from an event-stream response. Cancelling the task closes the
    /// connection, which is what a `.task(id:)` modifier gives for free.
    ///
    /// No SSE library: this is the whole protocol, and every library in the space
    /// either drops the `event:` name or reconnects with its own policy, which
    /// would fight the cursor this client already tracks.
    nonisolated func frames(_ endpoint: Endpoint) -> AsyncThrowingStream<SSEFrame, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try await self.request(for: endpoint)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    // No total deadline: a run may legitimately take ten minutes
                    // and the heartbeat is what proves liveness instead.
                    request.timeoutInterval = 0

                    let (bytes, response) = try await APIClient.streamingSession.bytes(for: request)
                    try APIClient.check(response, data: Data())

                    var parser = SSEParser()
                    for try await byte in bytes {
                        guard let frame = parser.consume(byte) else { continue }
                        continuation.yield(frame)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// One long-poll cycle. The server holds the request for up to 25 s and
    /// answers with the same rows the stream would have carried, so the two paths
    /// interleave on one cursor.
    func poll(_ runId: RunId, after: Int) async throws -> EventBatch {
        try await send(.events(runId, after: after, poll: true), as: EventBatch.self)
    }
}

extension APIClient {
    /// A separate session for streams. The ordinary one has a 120 s resource
    /// timeout, which would cut a long run's stream off mid-answer, and a tool
    /// call may legitimately take ten minutes.
    nonisolated static let streamingSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 0
        config.timeoutIntervalForResource = 0
        config.waitsForConnectivity = true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()
}

/// Reconnect timing, kept in one place so the transcript does not invent its own.
enum Backoff {
    static let steps: [Duration] = [
        .milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8),
    ]

    static func delay(attempt: Int) -> Duration {
        steps[min(attempt, steps.count - 1)]
    }

    /// The server heartbeats every 15 s. A stream with no frame for 45 s is dead
    /// in a way TCP will not report for minutes — a cellular NAT dropping the
    /// flow looks exactly like a model thinking.
    static let watchdog: Duration = .seconds(45)
}
