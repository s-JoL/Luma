import Foundation

/// One value per route, so URL building happens in one place and the call sites
/// read like `05-api.md`.
struct Endpoint: Sendable {
    var method: String = "GET"
    var path: String
    var query: [String: String?] = [:]
    var body: Data?
    var idempotencyKey: String?
    /// The credentials a privileged change needs on the request itself, as
    /// headers rather than in the body so no route changes shape for them.
    var stepUp: StepUp?
    /// When set, wins over the JSON default. Multipart uploads use this.
    var contentType: String?

    /// A GET, or a POST that carries an idempotency key, is safe to repeat.
    var isRetryable: Bool { method == "GET" || idempotencyKey != nil }
}

// MARK: - Routes

extension Endpoint {
    static func health() -> Endpoint { .init(path: "/health") }
    static func challenge() -> Endpoint { .init(path: "/auth/challenge") }

    static func token(accessCode: String, totp: String, deviceName: String) throws -> Endpoint {
        var fields: [String: String] = ["accessCode": accessCode, "deviceName": deviceName]
        if !totp.isEmpty { fields["totp"] = totp }
        return .init(method: "POST", path: "/auth/token", body: try JSON.encode(fields))
    }

    static func logout() -> Endpoint { .init(method: "POST", path: "/auth/logout") }
    static func bootstrap() -> Endpoint { .init(path: "/bootstrap") }

    // MARK: Conversations

    static func conversations(limit: Int = 30, cursor: String? = nil) -> Endpoint {
        .init(path: "/conversations", query: ["limit": String(limit), "cursor": cursor])
    }

    static func createConversation(modelId: ModelId?) throws -> Endpoint {
        var fields: [String: String] = [:]
        if let modelId, !modelId.raw.isEmpty { fields["modelId"] = modelId.raw }
        return .init(method: "POST", path: "/conversations", body: try JSON.encode(fields))
    }

    static func conversation(_ id: ConversationId) -> Endpoint {
        .init(path: "/conversations/\(id.raw)")
    }

    static func renameConversation(_ id: ConversationId, title: String) throws -> Endpoint {
        .init(method: "PATCH", path: "/conversations/\(id.raw)", body: try JSON.encode(["title": title]))
    }

    static func setConversationModel(_ id: ConversationId, modelId: ModelId) throws -> Endpoint {
        .init(
            method: "PATCH", path: "/conversations/\(id.raw)",
            body: try JSON.encode(["modelId": modelId.raw])
        )
    }

    static func deleteConversation(_ id: ConversationId) -> Endpoint {
        .init(method: "DELETE", path: "/conversations/\(id.raw)")
    }

    static func searchConversations(_ query: String, limit: Int = 20) -> Endpoint {
        .init(path: "/conversations/search", query: ["q": query, "limit": String(limit)])
    }

    /// Two different questions on one path. `after` is *what changed since I last
    /// looked*; `limit`/`before` is *give me the end of this transcript*. Sending
    /// an empty `before` would be a third question, so nil values are dropped.
    static func messages(
        _ id: ConversationId, limit: Int? = nil, before: Int? = nil, after: Int? = nil
    ) -> Endpoint {
        .init(
            path: "/conversations/\(id.raw)/messages",
            query: [
                "limit": limit.map(String.init),
                "before": before.map(String.init),
                "after": after.map(String.init),
            ]
        )
    }

    // MARK: Runs

    static func run(_ id: ConversationId, _ input: RunInput, key: String) throws -> Endpoint {
        .init(
            method: "POST", path: "/conversations/\(id.raw)/runs",
            body: try JSON.encode(input), idempotencyKey: key
        )
    }

    static func continueRun(_ id: ConversationId, key: String) -> Endpoint {
        .init(method: "POST", path: "/conversations/\(id.raw)/continue", idempotencyKey: key)
    }

    static func stop(_ id: ConversationId) -> Endpoint {
        .init(method: "POST", path: "/conversations/\(id.raw)/stop")
    }

    static func steer(_ id: ConversationId, text: String) throws -> Endpoint {
        .init(
            method: "POST", path: "/conversations/\(id.raw)/steer",
            body: try JSON.encode(["text": text])
        )
    }

    static func runStatus(_ id: RunId) -> Endpoint { .init(path: "/runs/\(id.raw)") }

    static func events(_ id: RunId, after: Int, poll: Bool) -> Endpoint {
        .init(
            path: "/runs/\(id.raw)/events",
            query: ["after": String(after), "mode": poll ? "poll" : nil]
        )
    }

    // MARK: Approvals

    static func approvals(_ id: ConversationId) -> Endpoint {
        .init(path: "/conversations/\(id.raw)/approvals")
    }

    static func decideApproval(_ id: ApprovalId, approved: Bool) throws -> Endpoint {
        .init(
            method: "POST", path: "/approvals/\(id.raw)",
            body: try JSON.encode(["approved": approved])
        )
    }

    // MARK: Files

    static func files(kind: String = "all", source: String = "all", q: String = "", limit: Int = 60, offset: Int = 0) -> Endpoint {
        .init(
            path: "/files",
            query: [
                "kind": kind,
                "source": source == "all" ? nil : source,
                "q": q.isEmpty ? nil : q,
                "limit": String(limit),
                "offset": String(offset),
            ]
        )
    }

    static func createNote(name: String, text: String) throws -> Endpoint {
        .init(method: "POST", path: "/files/notes", body: try JSON.encode(["name": name, "text": text]))
    }

    static func fileText(_ id: FileId) -> Endpoint { .init(path: "/files/\(id.raw)/text") }

    static func saveFileText(_ id: FileId, name: String, text: String) throws -> Endpoint {
        .init(method: "PUT", path: "/files/\(id.raw)/text", body: try JSON.encode(["name": name, "text": text]))
    }

    /// The bytes as they were uploaded, as opposed to `/text`'s extracted prose.
    /// Opening a document means handing the file itself to iOS, which wants it on
    /// disk under its own name rather than a string.
    static func fileContent(_ id: FileId) -> Endpoint { .init(path: "/files/\(id.raw)/content") }

    static func deleteFile(_ id: FileId) -> Endpoint {
        .init(method: "DELETE", path: "/files/\(id.raw)")
    }

    static func reindexFile(_ id: FileId) -> Endpoint {
        .init(method: "POST", path: "/files/\(id.raw)/reindex")
    }

    static func searchFiles(_ query: String) throws -> Endpoint {
        .init(method: "POST", path: "/files/search", body: try JSON.encode(["query": query]))
    }

    /// Never fetched through `send`: the bytes are a clip, and the server answers
    /// byte ranges so a player can seek without pulling the whole file. See
    /// `APIClient.mediaSource`.
    static func video(_ id: VideoId) -> Endpoint { .init(path: "/videos/\(id.raw)") }

    // MARK: Memory

    static func memory() -> Endpoint { .init(path: "/memory") }

    static func setMemory(key: String, value: String) throws -> Endpoint {
        .init(method: "PUT", path: "/memory/\(key)", body: try JSON.encode(["value": value]))
    }

    static func deleteMemory(key: String) -> Endpoint {
        .init(method: "DELETE", path: "/memory/\(key)")
    }

    // MARK: Studio + jobs

    static func studioTools() -> Endpoint { .init(path: "/studio/tools") }

    static func gallery(offset: Int = 0, limit: Int = 60) -> Endpoint {
        .init(path: "/studio/gallery", query: ["offset": String(offset), "limit": String(limit)])
    }

    static func jobs(status: String? = nil, limit: Int = 30) -> Endpoint {
        .init(path: "/jobs", query: ["status": status, "limit": String(limit)])
    }

    static func submitJob(_ input: JobInput) throws -> Endpoint {
        .init(method: "POST", path: "/jobs", body: try JSON.encode(input), idempotencyKey: APIClient.idempotencyKey())
    }

    static func job(_ id: JobId) -> Endpoint { .init(path: "/jobs/\(id.raw)") }

    static func cancelJob(_ id: JobId) -> Endpoint {
        .init(method: "POST", path: "/jobs/\(id.raw)/cancel")
    }

    static func jobEvents(_ id: JobId) -> Endpoint {
        .init(path: "/jobs/\(id.raw)/events")
    }

    // MARK: Settings

    static func capabilities() -> Endpoint { .init(path: "/capabilities") }

    static func patchCapabilities(_ body: some Encodable) throws -> Endpoint {
        .init(method: "PATCH", path: "/capabilities", body: try JSON.encode(body))
    }

    static func putSecret(_ name: String, value: String) throws -> Endpoint {
        .init(method: "PUT", path: "/capabilities/secrets/\(name)", body: try JSON.encode(["value": value]))
    }

    static func prompts() -> Endpoint { .init(path: "/prompts") }

    static func promptDefaults() -> Endpoint { .init(path: "/prompts/defaults") }

    static func savePrompts(_ prompts: PromptSettings) throws -> Endpoint {
        .init(method: "PUT", path: "/prompts", body: try JSON.encode(prompts))
    }

    static func setProviderKey(_ id: ProviderId, value: String) throws -> Endpoint {
        .init(method: "PUT", path: "/providers/\(id.raw)/key", body: try JSON.encode(["value": value]))
    }

    static func deleteProviderKey(_ id: ProviderId) -> Endpoint {
        .init(method: "DELETE", path: "/providers/\(id.raw)/key")
    }

    static func setDefaultModel(_ id: ModelId) throws -> Endpoint {
        .init(method: "PUT", path: "/models/default", body: try JSON.encode(["modelId": id.raw]))
    }

    /// Rebuilds every MCP connection. The reply carries the new status, but the
    /// app reads it back out of `bootstrap`, which is where every other screen
    /// takes it from.
    static func reconnectMcp() -> Endpoint { .init(method: "POST", path: "/mcp/reconnect") }

    // MARK: Security

    /// Readable on a live session; every write below is not. The step-up
    /// credentials travel as headers, so none of these bodies changes shape for
    /// them and a native client sends them exactly as the browser does.
    static func security() -> Endpoint { .init(path: "/security") }

    static func setAccessCode(_ value: String, step: StepUp) throws -> Endpoint {
        .init(
            method: "PUT", path: "/security/access-code",
            body: try JSON.encode(["value": value]), stepUp: step
        )
    }

    static func startTotp(step: StepUp) -> Endpoint {
        .init(method: "POST", path: "/security/totp", stepUp: step)
    }

    /// The only write here with no step-up: a code generated from the pending
    /// secret proves the authenticator holds it, which is the whole point of
    /// enrolling in two steps.
    static func confirmTotp(_ code: String) throws -> Endpoint {
        .init(method: "POST", path: "/security/totp/confirm", body: try JSON.encode(["code": code]))
    }

    /// The body's `code` is the server's fallback for the TOTP header, so it is
    /// the same value rather than a second one to disagree with.
    static func disableTotp(step: StepUp) throws -> Endpoint {
        .init(
            method: "DELETE", path: "/security/totp",
            body: try JSON.encode(["code": step.totp]), stepUp: step
        )
    }

    static func revokeSession(_ id: String, step: StepUp) -> Endpoint {
        .init(method: "DELETE", path: "/security/sessions/\(id)", stepUp: step)
    }

    static func revokeOtherSessions(step: StepUp) -> Endpoint {
        .init(method: "POST", path: "/security/sessions/revoke-others", stepUp: step)
    }
}

/// The body of `POST /conversations/:id/runs`. `fromSeq` deletes that message and
/// everything after it, then starts — which is how both edit and regenerate work.
struct RunInput: Encodable, Sendable {
    var text: String
    var attachments: [String] = []
    var modelId: String?
    var fromSeq: Int?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        if !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
        if let modelId, !modelId.isEmpty { try c.encode(modelId, forKey: .modelId) }
        if let fromSeq { try c.encode(fromSeq, forKey: .fromSeq) }
    }

    private enum CodingKeys: String, CodingKey { case text, attachments, modelId, fromSeq }
}

enum JSON {
    static let decoder = JSONDecoder()

    static func encode(_ value: some Encodable) throws -> Data {
        try JSONEncoder().encode(value)
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try decoder.decode(type, from: data)
    }
}
