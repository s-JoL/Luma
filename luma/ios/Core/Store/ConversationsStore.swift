import Foundation
import Observation

/// The conversation list: paging, search, and the mutations the rows offer.
@MainActor
@Observable
final class ConversationsStore {
    private(set) var items: [ConversationSummary] = []
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var isCreating = false
    private(set) var error: String?

    private(set) var searchResults: [ConversationSearchHit] = []
    private(set) var isSearching = false

    private var cursor: String?
    private var reachedEnd = false
    private let api: APIClient
    private var searchTask: Task<Void, Never>?

    /// Conversations this client is following a live run in. The list payload
    /// carries no active-run flag, so this is the only running state the app
    /// legitimately knows without a request per row.
    private(set) var running: Set<ConversationId> = []

    init(api: APIClient) {
        self.api = api
    }

    var hasMore: Bool { !reachedEnd }

    func reset() {
        items = []
        cursor = nil
        reachedEnd = false
        searchResults = []
        running = []
        error = nil
    }

    func loadFirstPage() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            let page = try await api.send(.conversations(limit: 30), as: Page<ConversationSummary>.self)
            items = page.items
            cursor = page.nextCursor
            reachedEnd = page.nextCursor == nil
            error = nil
        } catch let failure as APIError {
            error = failure.display
        } catch {
            self.error = APIError.transport("\(error)").display
        }
    }

    /// Re-reads the first page without clearing what is on screen. Used when the
    /// app returns to the foreground, where a spinner over a list the reader was
    /// already looking at would be a downgrade.
    func refresh() async {
        guard !isLoading else { return }
        do {
            let page = try await api.send(.conversations(limit: 30), as: Page<ConversationSummary>.self)
            guard !page.items.isEmpty || items.isEmpty else { return }
            let older = items.dropFirst(page.items.count)
            let fresh = Set(page.items.map(\.id))
            items = page.items + older.filter { !fresh.contains($0.id) }
            error = nil
        } catch {
            // Keep the list; the next pull-to-refresh can try again.
        }
    }

    /// Called when the last row appears. The list is never fully loaded — a
    /// two-year-old install has thousands.
    func loadMore() async {
        guard !isLoadingMore, !reachedEnd, let cursor else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let page = try await api.send(
                .conversations(limit: 30, cursor: cursor), as: Page<ConversationSummary>.self
            )
            let known = Set(items.map(\.id))
            items += page.items.filter { !known.contains($0.id) }
            self.cursor = page.nextCursor
            reachedEnd = page.nextCursor == nil || page.items.isEmpty
        } catch {
            // A failed page is not a failed list: the rows already on screen
            // stay, and the next scroll tries again.
            reachedEnd = false
        }
    }

    /// Debounced by the caller's `task(id:)`. A blank query clears rather than
    /// erroring, and a 1–2 character CJK query is answered by a substring scan
    /// rather than the trigram index, so "slow" here is not "broken" and the app
    /// must not add a second client-side search.
    func search(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            isSearching = false
            return
        }
        isSearching = true
        defer { isSearching = false }
        do {
            let page = try await api.send(
                .searchConversations(trimmed), as: Page<ConversationSearchHit>.self
            )
            searchResults = page.items
        } catch {
            searchResults = []
        }
    }

    func clearSearch() {
        searchTask?.cancel()
        searchResults = []
    }

    // MARK: Mutations

    /// A conversation cannot be created optimistically: its id comes from the
    /// server and the transcript is opened by id, so a local placeholder would be
    /// a row that opens nothing. What the caller gets instead is `isCreating`,
    /// which is what the button needs in order to answer the tap in the frame it
    /// happened in rather than a round trip later.
    func create(modelId: ModelId?, profileId: String?) async throws -> ConversationSummary {
        isCreating = true
        defer { isCreating = false }
        let created = try await api.send(
            .createConversation(modelId: modelId, profileId: profileId), as: ConversationSummary.self
        )
        items.insert(created, at: 0)
        return created
    }

    func rename(_ id: ConversationId, to title: String) async throws {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try await api.send(.renameConversation(id, title: trimmed))
        applyTitle(trimmed, to: id)
    }

    /// The server refuses while a run is active, and that `409` is a state the
    /// row can resolve rather than a failure to report as an error.
    func delete(_ id: ConversationId) async throws {
        try await api.send(.deleteConversation(id))
        items.removeAll { $0.id == id }
        running.remove(id)
    }

    /// Titles are generated asynchronously and arrive on the run's event stream,
    /// so the row animates its text when this lands.
    func applyTitle(_ title: String, to id: ConversationId) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        var updated = items
        updated[index] = ConversationSummary(existing: items[index], title: title)
        items = updated
    }

    /// Moves a conversation to the top, which is how the server orders the list.
    func touch(_ id: ConversationId) {
        guard let index = items.firstIndex(where: { $0.id == id }), index > 0 else { return }
        var updated = items
        let row = updated.remove(at: index)
        updated.insert(ConversationSummary(existing: row, updatedAt: Int(Date().timeIntervalSince1970 * 1000)), at: 0)
        items = updated
    }

    func setRunning(_ isRunning: Bool, for id: ConversationId) {
        if isRunning { running.insert(id) } else { running.remove(id) }
    }
}

private extension ConversationSummary {
    /// The wire type has no memberwise initialiser because it decodes
    /// defensively, so an optimistic update rebuilds it here.
    init(existing: ConversationSummary, title: String? = nil, updatedAt: Int? = nil) {
        self.init(
            id: existing.id,
            title: title ?? existing.title,
            modelId: existing.modelId,
            profileId: existing.profileId,
            createdAt: existing.createdAt,
            updatedAt: updatedAt ?? existing.updatedAt,
            messageCount: existing.messageCount
        )
    }
}

extension ConversationSummary {
    init(
        id: ConversationId, title: String, modelId: ModelId, profileId: String,
        createdAt: Int, updatedAt: Int, messageCount: Int
    ) {
        self.id = id
        self.title = title
        self.modelId = modelId
        self.profileId = profileId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
    }
}
