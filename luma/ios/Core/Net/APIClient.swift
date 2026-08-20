import Foundation

/// Request building, decoding and a deliberately narrow retry. An actor, because
/// the stores are `@MainActor` and the network must never touch them.
actor APIClient {
    private let session: URLSession
    private(set) var base: URL
    private var token: String?

    init(base: URL, token: String?) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        // The combination that makes a phone leaving a lift behave: the request
        // waits for the radio instead of failing, but a server that accepted the
        // connection and then went quiet does not hang the UI forever.
        config.waitsForConnectivity = true
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        config.urlCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 256 << 20)
        session = URLSession(configuration: config)
        self.base = base
        self.token = token
    }

    func setToken(_ value: String?) { token = value }
    func setBase(_ value: URL) { base = value }

    func send<T: Decodable & Sendable>(_ endpoint: Endpoint, as type: T.Type) async throws -> T {
        let data = try await raw(endpoint)
        do {
            return try JSON.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// For the 204 routes.
    @discardableResult
    func send(_ endpoint: Endpoint) async throws -> Data {
        try await raw(endpoint)
    }

    /// Retry is narrow on purpose: transport failures plus `503`/`429`, at most
    /// twice, and only for a request that is safe to repeat. The server's own
    /// `Idempotency-Key` handling is what makes a retried send a returned run
    /// rather than a duplicate message.
    private func raw(_ endpoint: Endpoint) async throws -> Data {
        var attempt = 0
        while true {
            do {
                return try await once(endpoint)
            } catch let error as APIError where error.isRetryable && endpoint.isRetryable && attempt < 2 {
                attempt += 1
                try await Task.sleep(for: .milliseconds(300 << attempt))
            }
        }
    }

    private func once(_ endpoint: Endpoint) async throws -> Data {
        let request = try request(for: endpoint)
        do {
            let (data, response) = try await session.data(for: request)
            try Self.check(response, data: data)
            return data
        } catch let error as APIError {
            throw error
        } catch let error as URLError {
            throw error.code == .notConnectedToInternet ? APIError.offline : .transport(error.localizedDescription)
        }
    }

    func request(for endpoint: Endpoint) throws -> URLRequest {
        var components = URLComponents(
            url: base.appending(path: endpoint.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
            resolvingAgainstBaseURL: false
        )
        // A nil query value is dropped rather than sent empty: `?before=` is a
        // different question from omitting it.
        let items = endpoint.query
            .compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
            .sorted { $0.name < $1.name }
        components?.queryItems = items.isEmpty ? nil : items

        guard let url = components?.url else { throw APIError.transport("Bad URL") }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.httpBody = endpoint.body
        if let contentType = endpoint.contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        } else if endpoint.body != nil, request.value(forHTTPHeaderField: "Content-Type") == nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        // Native clients use the header. The cookie path is web-only, and a
        // native client that used it would inherit the same-origin `Origin`
        // requirement for writes.
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let key = endpoint.idempotencyKey {
            request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        }
        for (name, value) in endpoint.stepUp?.headers ?? [:] {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    /// What a player needs in order to fetch media itself. AVFoundation builds
    /// its own requests and cannot be handed a `URLRequest`, so the address and
    /// the credential have to come back as values — a video fetched from a bare
    /// URL carries no bearer token and is refused.
    func mediaSource(_ endpoint: Endpoint) throws -> MediaSource {
        let request = try request(for: endpoint)
        guard let url = request.url else { throw APIError.transport("Bad URL") }
        return MediaSource(url: url, headers: request.allHTTPHeaderFields ?? [:])
    }

    static func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200..<300).contains(http.statusCode) else { return }

        // The envelope is parsed for `401` too, not just for the other statuses.
        // Sign-in reports three different things with that status — a wrong code,
        // `totp_required`, and a wrong TOTP — and collapsing them all into
        // `.unauthorized` loses the code the form branches on and replaces the
        // server's message with "登录已失效".
        guard let error = try? JSON.decode(ServerError.self, from: data) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.server(
                status: http.statusCode,
                ServerError(
                    code: "http_\(http.statusCode)",
                    message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                )
            )
        }
        throw APIError.server(status: http.statusCode, error)
    }
}

/// A route something outside `APIClient` will do the fetching for.
struct MediaSource: Sendable, Equatable {
    let url: URL
    let headers: [String: String]
}

extension APIClient {
    /// Every run POST carries one, so a retry after a dropped response returns
    /// the original run instead of starting a second.
    static func idempotencyKey() -> String { UUID().uuidString }

    func upload(data: Data, filename: String, mime: String, conversationId: String? = nil) async throws -> FileRecord {
        let boundary = "luma-\(UUID().uuidString)"
        var body = Data()
        func append(_ string: String) { body.append(Data(string.utf8)) }
        let safeName = filename.replacingOccurrences(of: "\"", with: "")
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n")
        append("Content-Type: \(mime)\r\n\r\n")
        body.append(data)
        append("\r\n")
        if let conversationId, !conversationId.isEmpty {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"conversationId\"\r\n\r\n")
            append("\(conversationId)\r\n")
        }
        append("--\(boundary)--\r\n")
        var endpoint = Endpoint(method: "POST", path: "/files", body: body)
        endpoint.contentType = "multipart/form-data; boundary=\(boundary)"
        return try await send(endpoint, as: FileRecord.self)
    }

    /// A document on disk, which is what Quick Look and the share sheet take.
    /// The write happens here rather than at the call site so it runs on this
    /// actor's executor: a 50MB attachment written from the main thread is a
    /// visible stall on the transcript it was opened from.
    ///
    /// One directory per file id, so opening the same document twice replaces
    /// the copy instead of growing the cache, and the server's own name inside
    /// it, so Quick Look can infer the type and a share carries the name the
    /// reader recognises.
    func download(_ id: FileId, name: String) async throws -> URL {
        let data = try await send(.fileContent(id))
        let directory = URL.temporaryDirectory.appending(
            path: "documents/\(id.raw)", directoryHint: .isDirectory
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: DocumentName.onDisk(name))
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// A name safe to write to disk. Names come from whatever was uploaded, and a
/// separator in one would put the file somewhere other than where it is about to
/// be read from — or, emptied by trimming, name the directory itself.
enum DocumentName {
    /// Long names are cut in the stem, never in the extension: the extension is
    /// what Quick Look infers the type from, and a `.pdf` that lost its suffix
    /// opens as nothing at all.
    static func onDisk(_ name: String) -> String {
        let cleaned = String(
            name
                .components(separatedBy: CharacterSet(charactersIn: "/\\:"))
                .joined(separator: "_")
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .drop { $0 == "." }
        )
        guard !cleaned.isEmpty else { return "document" }
        guard cleaned.utf8.count > 120 else { return cleaned }

        let suffix = (cleaned as NSString).pathExtension
        let stem = String((cleaned as NSString).deletingPathExtension.prefix(32))
        return suffix.isEmpty ? stem : "\(stem).\(suffix)"
    }
}
