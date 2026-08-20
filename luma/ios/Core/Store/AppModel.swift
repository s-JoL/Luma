import Foundation
import Observation

/// The root of the object graph. Stores are `@MainActor` and own every mutation;
/// clients are actors and never touch them. A view reads a store and calls a
/// method — it never calls `APIClient` directly, which is what keeps optimistic
/// updates, error handling and retry in one place instead of in forty.
@MainActor
@Observable
final class AppModel {
    enum Session: Equatable {
        /// First run, or the owner cleared the address.
        case needsServer
        case signedOut
        case signedIn
    }

    private(set) var session: Session
    private(set) var bootstrap: Bootstrap?
    private(set) var serverURL: URL?
    /// Round-trip time of the last bootstrap, for the diagnostics row.
    private(set) var lastBootstrapMillis: Int?
    var toast: Toast?

    private(set) var api: APIClient
    private(set) var conversations: ConversationsStore
    private(set) var library: LibraryStore
    private(set) var memory: MemoryStore
    private(set) var studio: StudioStore

    /// Warm transcripts, most-recently-used first. Three is enough to make
    /// tapping back and forth between two conversations instant without holding
    /// a phone's worth of memory.
    private var open: [ConversationId: TranscriptStore] = [:]
    private var recent: [ConversationId] = []
    private let warmLimit = 3

    init() {
        ServerLocator.applyLaunchReset()

        let base = ServerLocator.baseURL
        let token = AuthStore.token
        let root = base.map(ServerLocator.apiRoot) ?? URL(string: "http://127.0.0.1:8090/v1")!
        let client = APIClient(base: root, token: token)

        serverURL = base
        api = client
        conversations = ConversationsStore(api: client)
        library = LibraryStore(api: client)
        memory = MemoryStore(api: client)
        studio = StudioStore(api: client)
        session = base == nil ? .needsServer : (token == nil ? .signedOut : .signedIn)

        // `handle` is the only place that decides what a failure means, and a
        // store cannot be handed `self` until every stored property exists.
        library.attach(self)
        studio.attach(self)
    }

    // MARK: Server address

    /// Probes `GET /health` before accepting an address, so a typo is caught here
    /// rather than at the first message. Returns the version to show.
    func probe(_ typed: String) async throws -> Health {
        guard let base = ServerLocator.normalise(typed) else {
            throw APIError.transport("这个地址看不懂，试试 mac.local:8090")
        }
        let probe = APIClient(base: ServerLocator.apiRoot(base), token: nil)
        return try await probe.send(.health(), as: Health.self)
    }

    func useServer(_ typed: String) async {
        guard let base = ServerLocator.normalise(typed) else { return }

        // A device token belongs to the server that issued it. Pointing the app
        // at a different one and keeping the old token would send a credential
        // the new server has never heard of and read as an expired session.
        if base != serverURL {
            AuthStore.token = nil
            await api.setToken(nil)
            bootstrap = nil
            conversations.reset()
            library.reset()
            memory.reset()
            studio.reset()
        }

        ServerLocator.baseURL = base
        serverURL = base
        await api.setBase(ServerLocator.apiRoot(base))
        session = AuthStore.token == nil ? .signedOut : .signedIn
    }

    func forgetServer() {
        ServerLocator.baseURL = nil
        serverURL = nil
        session = .needsServer
    }

    // MARK: Sign in

    func challenge() async throws -> Challenge {
        try await api.send(.challenge(), as: Challenge.self)
    }

    func signIn(accessCode: String, totp: String) async throws {
        let grant = try await api.send(
            .token(accessCode: accessCode, totp: totp, deviceName: AuthStore.deviceName),
            as: TokenGrant.self
        )
        AuthStore.token = grant.token
        await api.setToken(grant.token)
        session = .signedIn
    }

    /// Clears local state and tells the server, in that order: a revoked token
    /// failing the logout call must still sign this device out.
    func signOut() async {
        let client = api
        AuthStore.token = nil
        session = .signedOut
        bootstrap = nil
        open.removeAll()
        recent.removeAll()
        conversations.reset()
        library.reset()
        memory.reset()
        studio.reset()
        Task { try? await client.send(.logout()) }
        await api.setToken(nil)
    }

    // MARK: Cold start

    /// A cold start is two calls in parallel. The conversation list is
    /// deliberately not in bootstrap: it is paged and changes far more often
    /// than settings do.
    func load() async {
        let started = Date()
        await ImageLoader.shared.use(api)
        async let settings = api.send(.bootstrap(), as: Bootstrap.self)
        async let list: Void = conversations.loadFirstPage()

        do {
            bootstrap = try await settings
            lastBootstrapMillis = Int(Date().timeIntervalSince(started) * 1000)
            await list
        } catch let error as APIError {
            _ = await list
            handle(error)
        } catch {
            _ = await list
        }
    }

    // MARK: Transcripts

    func transcript(for id: ConversationId) -> TranscriptStore {
        recent.removeAll { $0 == id }
        recent.insert(id, at: 0)

        if let existing = open[id] {
            trimWarm()
            return existing
        }
        let store = TranscriptStore(id: id, api: api, app: self)
        open[id] = store
        trimWarm()
        return store
    }

    private func trimWarm() {
        while recent.count > warmLimit, let dropped = recent.popLast() {
            open[dropped]?.detach()
            open.removeValue(forKey: dropped)
        }
    }

    // MARK: Errors

    /// One place decides what a failure means. `401` signs out from wherever it
    /// happened; `403` never does, because every one the app can receive is a
    /// step-up prompt answered by its own sheet.
    func handle(_ error: APIError) {
        if error.signsOut {
            Task { await signOut() }
            return
        }
        toast = Toast(message: error.display, isError: true)
    }

    func note(_ message: String) {
        toast = Toast(message: message, isError: false)
    }
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    let message: String
    var isError: Bool = false
}
